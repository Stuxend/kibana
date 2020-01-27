/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { SavedObjectsClientContract } from 'kibana/server';
import { KibanaAssetType } from '../../../../common/types';
import { RegistryPackage, Dataset } from '../../../../common/types';
import * as Registry from '../../../registry';
import { loadFieldsFromYaml, Fields, Field } from '../../fields/field';

interface FieldFormatMap {
  [key: string]: FieldFormatMapItem;
}
interface FieldFormatMapItem {
  id?: string;
  params?: FieldFormatParams;
}
interface FieldFormatParams {
  pattern?: string;
  inputFormat?: string;
  outputFormat?: string;
  outputPrecision?: number;
  labelTemplate?: string;
  urlTemplate?: string;
  openLinkInCurrentTab?: boolean;
}
/* this should match https://github.com/elastic/beats/blob/d9a4c9c240a9820fab15002592e5bb6db318543b/libbeat/kibana/fields_transformer.go */
interface TypeMap {
  [key: string]: string;
}
const typeMap: TypeMap = {
  binary: 'binary',
  half_float: 'number',
  scaled_float: 'number',
  float: 'number',
  integer: 'number',
  long: 'number',
  short: 'number',
  byte: 'number',
  text: 'string',
  keyword: 'string',
  '': 'string',
  geo_point: 'geo_point',
  date: 'date',
  ip: 'ip',
  boolean: 'boolean',
};

export interface IndexPatternField {
  name: string;
  type?: string;
  count: number;
  scripted: boolean;
  indexed: boolean;
  analyzed: boolean;
  searchable: boolean;
  aggregatable: boolean;
  doc_values: boolean;
  enabled?: boolean;
  script?: string;
  lang?: string;
  readFromDocValues: boolean;
}
interface KibanaIndexPattern {
  [key: string]: string;
}
enum IndexPatternType {
  logs = 'logs',
  metrics = 'metrics',
}

export async function installIndexPatterns(
  pkgkey: string,
  savedObjectsClient: SavedObjectsClientContract
) {
  const registryPackageInfo = await Registry.fetchInfo(pkgkey);
  const registryDatasets = registryPackageInfo.datasets;
  if (!registryDatasets) return;

  const indexPatternTypes = [IndexPatternType.logs, IndexPatternType.metrics];

  indexPatternTypes.forEach(async indexPatternType => {
    const datasets = registryDatasets.filter(dataset => dataset.type === indexPatternType);
    await createIndexPattern({
      datasetType: indexPatternType,
      datasets,
      registryPackageInfo,
      savedObjectsClient,
    });
  });
}

// loop through each dataset, get all the fields, create index pattern by type.
const createIndexPattern = async ({
  datasetType,
  datasets,
  registryPackageInfo,
  savedObjectsClient,
}: {
  datasetType: string;
  datasets: Dataset[];
  registryPackageInfo: RegistryPackage;
  savedObjectsClient: SavedObjectsClientContract;
}) => {
  const loadingFields = datasets.map(dataset =>
    loadFieldsFromYaml(registryPackageInfo, dataset.name)
  );
  const nestedResults = await Promise.all(loadingFields);
  const allFields = nestedResults.flat();

  const kibanaIndexPattern = makeKibanaIndexPattern(allFields, datasetType);
  await savedObjectsClient.create(KibanaAssetType.indexPattern, kibanaIndexPattern);
};

const makeKibanaIndexPattern = (fields: Fields, datasetType: string): KibanaIndexPattern => {
  const dedupedFields = dedupeFields(fields);
  const flattenedFields = flattenFields(dedupedFields);
  const fieldFormatMap = createFieldFormatMap(flattenedFields);
  const transformedFields = flattenedFields.map(transformField);

  return {
    title: datasetType + '-*',
    timeFieldName: '@timestamp',
    fields: JSON.stringify(transformedFields),
    fieldFormatMap: JSON.stringify(fieldFormatMap),
  };
};

export const dedupeFields = (fields: Fields) => {
  const uniqueObj = fields.reduce<{ [name: string]: Field }>((acc, field) => {
    if (!acc[field.name]) {
      acc[field.name] = field;
    }
    return acc;
  }, {});

  return Object.values(uniqueObj);
};

/**
 * search through fields with field's path property
 * returns undefined if field not found or field is not a leaf node
 * @param  allFields fields to search
 * @param  path dot separated path from field.path
 */
export const findFieldByPath = (allFields: Fields, path: string): Field | undefined => {
  const pathParts = path.split('.');
  return getField(allFields, pathParts);
};

const getField = (fields: Fields, pathNames: string[]): Field | undefined => {
  if (!pathNames.length) return undefined;
  // get the first rest of path names
  const [name, ...restPathNames] = pathNames;
  for (const field of fields) {
    if (field.name === name) {
      // check field's fields, passing in the remaining path names
      if (field.fields && field.fields.length > 0) {
        return getField(field.fields, restPathNames);
      }
      // no nested fields to search, but still more names - not found
      if (restPathNames.length) {
        return undefined;
      }
      return field;
    }
  }
  return undefined;
};

export const transformField = (field: Field, i: number, fields: Fields): IndexPatternField => {
  const newField: IndexPatternField = {
    name: field.name,
    count: field.count ?? 0,
    scripted: false,
    indexed: field.index ?? true,
    analyzed: field.analyzed ?? false,
    searchable: field.searchable ?? true,
    aggregatable: field.aggregatable ?? true,
    doc_values: field.doc_values ?? true,
    readFromDocValues: true,
  };

  // if type exists, check if it exists in the map
  if (field.type) {
    // if no type match type is not set (undefined)
    if (typeMap[field.type]) {
      newField.type = typeMap[field.type];
    }
    // if type isn't set, default to string
  } else {
    newField.type = 'string';
  }

  if (newField.type === 'binary') {
    newField.aggregatable = false;
    newField.analyzed = false;
    newField.doc_values = field.doc_values ?? false;
    newField.indexed = false;
    newField.searchable = false;
  }

  if (field.type === 'object' && field.hasOwnProperty('enabled')) {
    const enabled = field.enabled ?? true;
    newField.enabled = enabled;
    if (!enabled) {
      newField.aggregatable = false;
      newField.analyzed = false;
      newField.doc_values = false;
      newField.indexed = false;
      newField.searchable = false;
    }
  }

  if (field.type === 'text') {
    newField.aggregatable = false;
  }

  if (field.hasOwnProperty('script')) {
    newField.scripted = true;
    newField.script = field.script;
    newField.lang = 'painless';
    newField.doc_values = false;
  }

  return newField;
};

/**
 * flattenFields
 *
 * flattens fields and renames them with a path of the parent names
 */

export const flattenFields = (allFields: Fields): Fields => {
  const flatten = (fields: Fields): Fields =>
    fields.reduce<Field[]>((acc, field) => {
      // recurse through nested fields
      if (field.type === 'group' && field.fields?.length) {
        // skip if field.enabled is not explicitly set to false
        if (!field.hasOwnProperty('enabled') || field.enabled === true) {
          acc = renameAndFlatten(field, field.fields, [...acc]);
        }
      } else {
        // handle alias type fields
        if (field.type === 'alias' && field.path) {
          const foundField = findFieldByPath(allFields, field.path);
          // if aliased leaf field is found copy its props over except path and name
          if (foundField) {
            const { path, name } = field;
            field = { ...foundField, path, name };
          }
        }
        // add field before going through multi_fields because we still want to add the parent field
        acc.push(field);

        // for each field in multi_field add new field
        if (field.multi_fields?.length) {
          acc = renameAndFlatten(field, field.multi_fields, [...acc]);
        }
      }
      return acc;
    }, []);

  // helper function to call flatten() and rename the fields
  const renameAndFlatten = (field: Field, fields: Fields, acc: Fields): Fields => {
    const flattenedFields = flatten(fields);
    flattenedFields.forEach(nestedField => {
      acc.push({
        ...nestedField,
        name: `${field.name}.${nestedField.name}`,
      });
    });
    return acc;
  };

  return flatten(allFields);
};

export const createFieldFormatMap = (fields: Fields): FieldFormatMap =>
  fields.reduce<FieldFormatMap>((acc, field) => {
    if (field.format || field.pattern) {
      const fieldFormatMapItem: FieldFormatMapItem = {};
      if (field.format) {
        fieldFormatMapItem.id = field.format;
      }
      const params = getFieldFormatParams(field);
      if (Object.keys(params).length) fieldFormatMapItem.params = params;
      acc[field.name] = fieldFormatMapItem;
    }
    return acc;
  }, {});

const getFieldFormatParams = (field: Field): FieldFormatParams => {
  const params: FieldFormatParams = {};
  if (field.pattern) params.pattern = field.pattern;
  if (field.input_format) params.inputFormat = field.input_format;
  if (field.output_format) params.outputFormat = field.output_format;
  if (field.output_precision) params.outputPrecision = field.output_precision;
  if (field.label_template) params.labelTemplate = field.label_template;
  if (field.url_template) params.urlTemplate = field.url_template;
  if (field.open_link_in_current_tab) params.openLinkInCurrentTab = field.open_link_in_current_tab;
  return params;
};
