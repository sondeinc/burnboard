'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  vendorFilterValue,
  vendorFromFilter,
  vendorForModel,
  vendorForRecord,
  matchesModelFilter,
  modelGroups,
} = require('../lib/model-facets');

test('model families map to canonical parent vendors before filtering', () => {
  const records = [
    { source: 'codex', model: 'gpt-6-sol' },
    { source: 'codex', model: null, autoReview: true },
    { source: 'codex', model: 'claude-opus-4-1' },
    { source: 'anthropic', model: null },
    { source: 'proxy', model: 'o3' },
    { source: 'claude', model: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  ];

  assert.equal(vendorFilterValue('codex'), 'vendor:codex');
  assert.equal(vendorFilterValue('openai-codex'), 'vendor:codex');
  assert.equal(vendorFromFilter('vendor:claude'), 'claude');
  assert.equal(vendorForModel('CLAUDE-SONNET-4-5-20250929'), 'claude');
  assert.equal(vendorForModel('gpt-6.1-sol'), 'codex');
  assert.equal(vendorForRecord(records[2]), 'claude');
  assert.equal(vendorForRecord(records[3]), 'claude');
  assert.equal(vendorForRecord(records[4]), 'codex');
  assert.deepEqual(records.filter((record) => matchesModelFilter(record, 'vendor:codex')),
    [records[0], records[1], records[4]]);
  assert.deepEqual(records.filter((record) => matchesModelFilter(record, 'vendor:claude')),
    [records[2], records[3], records[5]]);
  assert.deepEqual(records.filter((record) => matchesModelFilter(record, 'gpt-6-sol')), records.slice(0, 1));
  assert.deepEqual(records.filter((record) => matchesModelFilter(record, 'codex-auto-review')), records.slice(1, 2));
  assert.deepEqual(records.filter((record) => matchesModelFilter(record, 'claude-opus-5-5')), records.slice(5, 6));
});

test('model facets group models beneath every configured vendor', () => {
  const groups = modelGroups([
    { source: 'codex', model: 'gpt-6-sol' },
    { source: 'codex', model: 'gpt-6-astra', autoReview: true },
    { source: 'codex', model: 'claude-opus-4-1' },
    { source: 'claude', model: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  ], [
    { id: 'openai', label: 'OpenAI' },
    { id: 'claude', label: 'Claude Code' },
    { id: 'future', label: 'Future Agent' },
  ]);

  assert.deepEqual(groups, [
    { id: 'codex', label: 'Codex', models: ['codex-auto-review', 'gpt-6-astra', 'gpt-6-sol'] },
    { id: 'claude', label: 'Claude', models: ['claude-opus-4-1', 'claude-opus-5-5', 'claude-sonnet-5-5'] },
    { id: 'future', label: 'Future Agent', models: [] },
  ]);
});
