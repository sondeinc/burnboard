'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelSlices, sliceRecordByModel } = require('../lib/model-usage');

const record = {
  id: 'mixed-session',
  model: 'claude-sonnet-5-5',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  totals: { total: 165, billed: 165 },
  toolCalls: 2,
  recentCmds: [
    { b: 'Read', k: 10, m: 'claude-opus-5-5' },
    { b: 'Read', k: 15, m: 'claude-sonnet-5-5' },
  ],
  modelUsage: {
    'claude-opus-5-5': {
      totals: { total: 110, input: 10, cached: 90, output: 10, billed: 110 },
      toolCalls: 1,
      cmds: [{ base: 'Read', tokens: 10, count: 1 }],
    },
    'claude-sonnet-5-5': {
      totals: { total: 55, input: 10, cached: 40, output: 5, billed: 55 },
      toolCalls: 1,
      cmds: [{ base: 'Read', tokens: 15, count: 1 }],
    },
  },
};

test('an exact model slice owns only that model usage and commands', () => {
  const sonnet = sliceRecordByModel(record, 'claude-sonnet-5-5');

  assert.equal(sonnet.model, 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.models, ['claude-sonnet-5-5']);
  assert.equal(sonnet.totals.billed, 55);
  assert.equal(sonnet.toolCalls, 1);
  assert.deepEqual(sonnet.recentCmds, [record.recentCmds[1]]);
});

test('model slices reconcile exactly to the unsliced session total', () => {
  const slices = modelSlices(record);
  assert.equal(slices.length, 2);
  assert.equal(slices.reduce((sum, slice) => sum + slice.totals.billed, 0), record.totals.billed);
  assert.equal(slices.reduce((sum, slice) => sum + slice.toolCalls, 0), record.toolCalls);
});
