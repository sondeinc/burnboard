'use strict';

const blankTotals = () => ({ total: 0, input: 0, output: 0, cached: 0, reasoning: 0, billed: 0 });
const realModel = (model) => !!model && !String(model).startsWith('<');

function recordModel(record, model) {
  if (!realModel(model)) return null;
  if (!Array.isArray(record.models)) record.models = [];
  if (!record.models.includes(model)) record.models.push(model);
  if (!record.modelUsage || typeof record.modelUsage !== 'object') record.modelUsage = {};
  return record.modelUsage[model] || (record.modelUsage[model] = {
    totals: blankTotals(),
    toolCalls: 0,
    pollTurns: 0,
    outTokens: 0,
    cmds: [],
    outByBase: {},
    bigOutputs: [],
    dupes: {},
    samples: {},
    pollTargets: [],
  });
}

function addModelTokens(record, model, usage) {
  const bucket = recordModel(record, model);
  if (!bucket) return;
  const totals = bucket.totals;
  totals.input += usage.input || 0;
  totals.cached += usage.cached || 0;
  totals.output += usage.output || 0;
  totals.reasoning += usage.reasoning || 0;
  totals.billed += usage.billed != null
    ? usage.billed : (usage.input || 0) + (usage.cached || 0) + (usage.output || 0);
  totals.total = totals.input + totals.cached + totals.output;
}

function addModelCommand(record, model, base, tokens, cls, { poll = false } = {}) {
  const bucket = recordModel(record, model);
  if (!bucket) return;
  bucket.toolCalls++;
  if (poll) bucket.pollTurns++;
  let command = bucket.cmds.find((entry) => entry.base === base);
  if (!command) {
    command = { base, tokens: 0, count: 0, cls: { i: 0, cc: 0, o: 0 } };
    bucket.cmds.push(command);
  }
  command.tokens += tokens || 0;
  command.count++;
  command.cls.i += (cls && cls.i) || 0;
  command.cls.cc += (cls && cls.cc) || 0;
  command.cls.o += (cls && cls.o) || 0;
}

function addModelOutput(record, model, { base, cmd, tokens, truncated, duplicate = true, big = true }) {
  const bucket = recordModel(record, model);
  if (!bucket) return;
  bucket.outTokens += tokens || 0;
  const output = bucket.outByBase[base] || (bucket.outByBase[base] = { tokens: 0, calls: 0, truncated: 0 });
  output.tokens += tokens || 0;
  output.calls++;
  if (truncated) output.truncated++;
  if (!cmd) return;

  const key = String(cmd).slice(0, 200);
  const samples = bucket.samples[base] || (bucket.samples[base] = {});
  const sample = samples[key] || (samples[key] = { count: 0, out: 0, trunc: 0 });
  sample.count++;
  sample.out += tokens || 0;
  if (truncated) sample.trunc++;

  if (duplicate) {
    const dupe = bucket.dupes[key] || (bucket.dupes[key] = { count: 0, tokens: 0 });
    dupe.count++;
    dupe.tokens += tokens || 0;
  }
  if (big && tokens >= 4000) {
    bucket.bigOutputs.push({ base, cmd: String(cmd).slice(0, 160), tokens, truncated: !!truncated });
  }
}

function finalizeModelUsage(record) {
  for (const bucket of Object.values(record.modelUsage || {})) {
    bucket.bigOutputs = (bucket.bigOutputs || []).sort((a, b) => b.tokens - a.tokens).slice(0, 8);
    if (!Array.isArray(bucket.dupes)) {
      bucket.dupes = Object.entries(bucket.dupes || {})
        .filter(([, value]) => value.count >= 3)
        .map(([cmd, value]) => ({ cmd, count: value.count, tokens: value.tokens }))
        .sort((a, b) => b.tokens - a.tokens).slice(0, 12);
    }
    for (const base of Object.keys(bucket.samples || {})) {
      if (Array.isArray(bucket.samples[base])) continue;
      bucket.samples[base] = Object.entries(bucket.samples[base])
        .map(([cmd, value]) => ({ cmd, count: value.count, out: value.out, trunc: value.trunc }))
        .sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 10);
    }
  }
  return record;
}

function modelsForRecord(record) {
  const models = new Set();
  for (const model of Object.keys((record && record.modelUsage) || {})) if (realModel(model)) models.add(model);
  for (const model of (record && record.models) || []) if (realModel(model)) models.add(model);
  if (record && realModel(record.model || record.primaryModel)) models.add(record.model || record.primaryModel);
  return [...models];
}

function sliceRecordByModel(record, model) {
  const bucket = record && record.modelUsage && record.modelUsage[model];
  if (!bucket) return record && (record.model === model || record.primaryModel === model) ? record : null;
  const taggedCommands = (record.recentCmds || []).some((command) => command.m);
  return {
    ...record,
    model,
    models: [model],
    totals: bucket.totals,
    cmds: bucket.cmds || [],
    recentCmds: taggedCommands ? (record.recentCmds || []).filter((command) => command.m === model) : (record.recentCmds || []),
    toolCalls: bucket.toolCalls || 0,
    pollTurns: bucket.pollTurns || 0,
    outTokens: bucket.outTokens || 0,
    outByBase: bucket.outByBase || {},
    bigOutputs: bucket.bigOutputs || [],
    dupes: bucket.dupes || [],
    samples: bucket.samples || {},
    pollTargets: bucket.pollTargets || [],
    textTokenMeasurements: {},
  };
}

function modelSlices(record) {
  const models = Object.entries((record && record.modelUsage) || {})
    .filter(([, bucket]) => (bucket.totals && bucket.totals.billed) || bucket.toolCalls || bucket.outTokens)
    .map(([model]) => model);
  if (!models.length) return [record];
  return models.map((model) => sliceRecordByModel(record, model));
}

module.exports = {
  addModelCommand,
  addModelOutput,
  addModelTokens,
  finalizeModelUsage,
  modelSlices,
  modelsForRecord,
  recordModel,
  sliceRecordByModel,
};
