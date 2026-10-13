'use strict';

const { modelsForRecord } = require('./model-usage');

const VENDOR_FILTER_PREFIX = 'vendor:';
const MODEL_VENDOR_MAPPINGS = [
  {
    id: 'codex',
    label: 'Codex',
    sourceAliases: ['codex', 'codex-cli', 'openai', 'openai-codex'],
    modelPrefixes: ['gpt-', 'codex-', 'chatgpt-', 'o1-', 'o3-', 'o4-'],
    modelNames: ['o1', 'o3', 'o4', 'codex-auto-review'],
  },
  {
    id: 'claude',
    label: 'Claude',
    sourceAliases: ['claude', 'claude-code', 'anthropic'],
    modelPrefixes: ['claude-', 'opus-', 'sonnet-', 'haiku-'],
    modelNames: ['opus', 'sonnet', 'haiku'],
  },
];

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function vendorForSource(source) {
  const value = normalized(source);
  if (!value) return '';
  const mapping = MODEL_VENDOR_MAPPINGS.find((entry) => entry.sourceAliases.includes(value));
  return mapping ? mapping.id : value;
}

function vendorForModel(model) {
  const value = normalized(model);
  if (!value) return '';
  const mapping = MODEL_VENDOR_MAPPINGS.find((entry) => entry.modelNames.includes(value)
    || entry.modelPrefixes.some((prefix) => value.startsWith(prefix)));
  return mapping ? mapping.id : '';
}

function vendorForRecord(record) {
  if (!record) return '';
  if (record.autoReview || record.agentKind === 'guardian') return 'codex';
  return vendorForModel(record.model || record.primaryModel)
    || vendorForSource(record.vendor || record.source);
}

function vendorLabel(vendor, fallback) {
  const mapping = MODEL_VENDOR_MAPPINGS.find((entry) => entry.id === vendor);
  return mapping ? mapping.label : (fallback || vendor);
}

function vendorFilterValue(source) {
  const vendor = vendorForSource(source);
  return vendor ? VENDOR_FILTER_PREFIX + vendor : '';
}

function vendorFromFilter(value) {
  const text = String(value || '');
  return text.startsWith(VENDOR_FILTER_PREFIX)
    ? vendorForSource(text.slice(VENDOR_FILTER_PREFIX.length)) : '';
}

function matchesModelFilter(record, value) {
  if (!value) return true;
  const vendor = vendorFromFilter(value);
  if (vendor) return vendorForRecord(record) === vendor;
  return modelsForRecord(record).includes(value)
    || (value === 'codex-auto-review' && record.autoReview);
}

function modelGroups(records, sources) {
  const groups = new Map();
  for (const source of sources || []) {
    const id = vendorForSource(source.id);
    if (!groups.has(id)) groups.set(id, { id, label: vendorLabel(id, source.label), models: new Set() });
  }

  for (const record of records || []) {
    const vendor = vendorForRecord(record) || 'other';
    if (!groups.has(vendor)) groups.set(vendor, { id: vendor, label: vendorLabel(vendor), models: new Set() });
    const models = groups.get(vendor).models;
    for (const model of modelsForRecord(record)) models.add(model);
    if (record.autoReview) models.add('codex-auto-review');
  }

  return [...groups.values()].map((group) => ({
    id: group.id,
    label: group.label,
    models: [...group.models].sort(),
  }));
}

module.exports = {
  VENDOR_FILTER_PREFIX,
  MODEL_VENDOR_MAPPINGS,
  vendorFilterValue,
  vendorFromFilter,
  vendorForSource,
  vendorForModel,
  vendorForRecord,
  matchesModelFilter,
  modelGroups,
};
