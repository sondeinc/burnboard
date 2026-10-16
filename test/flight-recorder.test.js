'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSession, createFlightRecorder, operationOf, pathsOf, isCompletionClaim } = require('../lib/flight-recorder');
const { normalize } = require('../lib/investigation');
const { investigationUrl, severityRank } = require('../lib/ui/flight-recorder');

const start = Date.parse('2026-10-16T12:00:00Z');
const stamp = seconds => new Date(start + seconds * 1000).toISOString();
const event = (id, seconds, kind, text, extra = {}) => ({ id, ts: stamp(seconds), kind, text, ...extra });
const tool = (id, seconds, callId, command, name = 'exec_command') => event(id, seconds, 'tool', JSON.stringify({ cmd: command }), { callId, name });
const result = (id, seconds, callId, text, isError = false) => event(id, seconds, 'result', text, { callId, isError });
const session = (key, overrides = {}) => ({ key, id: key, source: 'codex', repo: 'sonde', cwd: `/repo/.worktrees/${key}`,
  title: key, minTime: start, maxTime: start + 300000, mtime: start + 300000, ...overrides });

test('attention rules collapse equivalent failures, distinguish benign repetition, and retain uncertainty', () => {
  const events = [
    tool('t1', 1, 'c1', 'npm test'), result('r1', 2, 'c1', 'Process exited with code 1\n2 tests failed'),
    tool('t2', 3, 'c2', 'npm test'), result('r2', 4, 'c2', 'Process exited with code 1\n2 tests failed'),
    tool('changed', 4.1, 'changed-call', 'npm test -- --changed'), result('changed-result', 4.2, 'changed-call', 'Process exited with code 1\n1 test failed'),
    tool('recovered', 4.3, 'recovered-call', 'npm test'), result('recovered-result', 4.4, 'recovered-call', 'Process exited with code 0\n10 tests passed'),
    tool('t3', 5, 'c3', 'git status'), result('r3', 6, 'c3', 'clean'),
    tool('t4', 7, 'c4', 'git status'), result('r4', 8, 'c4', 'clean'),
    tool('t5', 9, 'c5', 'git status'), result('r5', 10, 'c5', 'clean'),
  ];
  const analysis = analyzeSession(session('rules'), events, start + 600000);
  const failure = analysis.findings.find(finding => finding.rule === 'repeated-failure');
  const repeated = analysis.findings.find(finding => finding.rule === 'repeated-command');
  assert.equal(failure.evidenceCount, 4);
  assert.match(failure.uncertainty, /does not prove/);
  assert.equal(repeated.severity, 'low');
  assert.match(repeated.rationale, /intentional polling/);
});

test('pending calls and post-validation changes produce bounded evidence findings', () => {
  const events = [
    event('request', 0, 'human', 'Fix it'),
    tool('test', 10, 'test-call', 'npm test'), result('test-result', 20, 'test-call', '10 tests passed'),
    event('edit', 30, 'tool', JSON.stringify({ patch: '*** Update File: src/app.js\n' }), { callId: 'edit-call', name: 'apply_patch' }),
    event('claim', 40, 'agent', 'Implemented and ready.'),
    tool('wait', 50, 'wait-call', 'long-running-process'),
  ];
  const analysis = analyzeSession(session('verification'), events, start + 20 * 60000);
  const stale = analysis.findings.find(finding => finding.rule === 'stale-verification');
  const pending = analysis.findings.find(finding => finding.rule === 'long-wait');
  assert.match(stale.trigger, /change was recorded after/);
  assert.equal(pending.severity, 'high');
  assert.deepEqual(pathsOf(events[3]), ['src/app.js']);
  assert.equal(operationOf(events[3]), 'change');
  assert.equal(analysis.trail.validations[0].outcome, 'passed');
});

test('worktree lanes, explicit child acknowledgement, overlaps, and trail states remain qualified', async () => {
  const editA = event('edit-a', 30, 'tool', JSON.stringify({ patch: '*** Update File: shared.js\n' }), { callId: 'ea', name: 'apply_patch' });
  const editB = event('edit-b', 40, 'tool', JSON.stringify({ patch: '*** Update File: shared.js\n' }), { callId: 'eb', name: 'apply_patch' });
  const sessions = [session('parent', { id: 'parent-id', cwd: '/repo' }), session('child', { parentId: 'parent-id' })];
  const records = new Map([['parent', [editA]], ['child', [editB, event('child-result', 60, 'agent', 'Finished the child task')]]]);
  const investigation = {
    status: () => ({ revision: 1 }), sessions: () => sessions,
    async *sessionEvents(key) { yield* records.get(key); },
  };
  const service = createFlightRecorder({ investigation, now: () => start + 15 * 60000 });
  const overview = await service.overview({ since: start });
  assert.deepEqual(overview.coverage, { availableSessions: 2, analyzedSessions: 2, maxSessions: 300, maxEventsPerSession: 5000, truncatedSessions: 0,
    matchedFindings: 4, returnedFindings: 4, maxFindings: 250, matchedOverlaps: 1, returnedOverlaps: 1, maxOverlaps: 200 });
  assert.equal(overview.lanes.length, 2);
  assert.equal(overview.lanes.find(lane => lane.cwd.includes('.worktrees')).kind, 'worktree-shaped');
  assert.match(overview.overlaps[0].label, /not proof of a merge conflict/);
  const child = overview.findings.find(finding => finding.rule === 'unacknowledged-child');
  assert.match(child.rationale, /No acknowledgement recorded/);
  assert.equal(child.parentSession, 'parent');
  const trail = await service.session('child');
  assert.equal(trail.claims.length, 1);
  assert.match(trail.coverage, /Current filesystem state was not used/);
  assert.equal((await service.overview({ since: start, rules: '' })).findings.length, 0);
});

test('outcome trails keep command result, validation scope, and completion claims independent', async () => {
  const records = [event('request', 0, 'human', 'Validate it'), tool('test', 1, 'test-call', 'npm test'),
    result('test-result', 2, 'test-call', 'exit_code: 0\n10 tests passed'), event('claim', 3, 'agent', 'Completed the requested work.')];
  const investigation = { status: () => ({ revision: 1 }), sessions: () => [session('trail')], async *sessionEvents() { yield* records; } };
  const trail = await createFlightRecorder({ investigation, now: () => start + 5000 }).session('trail');
  assert.equal(trail.commands[0].outcome, 'succeeded');
  assert.equal(trail.validations[0].outcome, 'passed');
  assert.match(trail.validations[0].scope, /Recorded working directory/);
  assert.equal(trail.claims.length, 1);
  assert.equal(trail.commits.length, 0);
});

test('finding links preserve local evidence identity and severity ordering', () => {
  const href = investigationUrl({ session: 'one', from: 10, to: 20, evidence: [{ session: 'one', id: 'event:1' }] });
  assert.match(href, /^#investigate\?/);
  assert.match(href, /event=event%3A1/);
  assert.ok(severityRank('high') > severityRank('medium'));
});

test('completion claims are direct statements, not incidental hook or instruction wording', () => {
  assert.equal(isCompletionClaim(event('claim', 1, 'agent', 'Implemented the requested repair.')), true);
  assert.equal(isCompletionClaim(event('claim', 1, 'agent', 'The fix is ready for review.')), true);
  assert.equal(isCompletionClaim(event('hook', 1, 'agent', 'Stop hook blocking error: Before finishing, check your work.')), false);
  assert.equal(isCompletionClaim(event('system', 1, 'agent', '<system-reminder>Mark the work done only after testing.</system-reminder>')), false);
  assert.equal(isCompletionClaim(event('blocked', 1, 'agent', 'Not done; still need to test.')), false);
});

test('Codex and Claude tool records drive the same failure rule without losing source semantics', () => {
  const codex = [
    ...normalize({ type: 'response_item', timestamp: stamp(1), payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"npm test"}' } }, { source: 'codex' }),
    ...normalize({ type: 'response_item', timestamp: stamp(2), payload: { type: 'function_call_output', call_id: 'c1', output: 'exit_code: 1 error' } }, { source: 'codex' }),
  ];
  const claude = [
    ...normalize({ type: 'assistant', timestamp: stamp(3), message: { content: [{ type: 'tool_use', id: 'c2', name: 'exec_command', input: { cmd: 'npm test' } }] } }, { source: 'claude' }),
    ...normalize({ type: 'user', timestamp: stamp(4), message: { content: [{ type: 'tool_result', tool_use_id: 'c2', is_error: true, content: 'error' }] } }, { source: 'claude' }),
  ];
  const events = [...codex, ...claude, ...codex.map((item, index) => ({ ...item, id: `again-${index}`, callId: 'c3', ts: stamp(5 + index) }))]
    .map((item, index) => ({ id: item.id || `source-${index}`, ...item }));
  const analysis = analyzeSession(session('mixed', { source: 'mixed' }), events, start + 600000);
  assert.ok(analysis.findings.some(finding => finding.rule === 'repeated-failure'));
  assert.equal(codex[0].name, 'exec_command');
  assert.equal(claude[1].isError, true);
});
