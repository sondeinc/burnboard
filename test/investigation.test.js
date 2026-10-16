'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createInvestigation, normalize, MAX_RECORD, VERSION } = require('../lib/investigation');
const { handoff, timeAt, fractionAt, escape } = require('../lib/ui/investigate');
const codex = require('../lib/sources/codex');
const claude = require('../lib/sources/claude');
const at = '2026-10-16T10:00:00.000Z';
const record = (type, payload, timestamp = at) => ({ type, payload, timestamp });
const message = text => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function fixture(t, rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-investigation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'codex'), claudeRoot = path.join(dir, 'claude');
  const date = path.join(root, 'sessions', '2026', '10', '16');
  const project = path.join(claudeRoot, 'projects', 'example');
  fs.mkdirSync(date, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const file = path.join(date, 'rollout-2026-10-16T10-00-00-11111111-1111-1111-1111-111111111111.jsonl');
  const initial = [record('session_meta', { id: 'one', cwd: '/project/.worktrees/codex/repair', git: { branch: 'main', repository_url: 'example/project' } }),
    record('turn_context', { model: 'gpt-5', effort: 'high' }), ...rows];
  fs.writeFileSync(file, initial.map(row => JSON.stringify(row)).join('\r\n') + '\r\n');
  const sources = [codex({ argVal: (name, fallback) => name === '--root' ? root : fallback }),
    claude({ argVal: (name, fallback) => name === '--claude-root' ? claudeRoot : fallback })];
  const cacheDir = path.join(dir, 'index');
  return { dir, file, project, root, claudeRoot, sources, cacheDir, service: createInvestigation({ sources, cacheDir }) };
}

test('Unicode and CRLF source offsets round-trip, unknown records and multiple tool blocks survive', async t => {
  const f = fixture(t, [message('Fix café 🧪'), record('new_record', { hidden: 'still inspectable' })]);
  const c = { type: 'assistant', uuid: 'claude-row', timestamp: at, cwd: '/project', message: { model: 'claude-sonnet-4', content: [
    { type: 'text', text: 'Inspect both files' },
    { type: 'tool_use', id: 'needle-call-a', name: 'Read', input: { file_path: 'a.js' } },
    { type: 'tool_use', id: 'needle-call-b', name: 'Read', input: { file_path: 'b.js' } },
  ] } };
  fs.writeFileSync(path.join(f.project, 'claude-session.jsonl'), JSON.stringify(c) + '\n' + JSON.stringify({ type: 'user', timestamp: at, message: { content: [
    { type: 'tool_result', tool_use_id: 'needle-call-b', content: 'result B' },
    { type: 'tool_result', tool_use_id: 'needle-call-a', content: 'result A' },
  ] } }) + '\n');
  const original = fs.readFileSync(f.file);
  await f.service.refresh(true);
  const codexSession = f.service.sessions({ source: 'codex' })[0];
  const human = (await f.service.query({ session: codexSession.key, kind: 'human' })).events[0];
  const raw = await f.service.getRaw(codexSession.key, human.id);
  assert.equal(raw.event.text, 'Fix café 🧪');
  assert.equal(raw.location.offset, original.indexOf(Buffer.from(JSON.stringify(message('Fix café 🧪')))));
  assert.equal(raw.location.line, 3);
  assert.deepEqual(raw.original, message('Fix café 🧪'));
  assert.equal((await f.service.query({ q: 'still inspectable' })).events[0].originalType, 'new_record');
  const tools = (await f.service.query({ source: 'claude', kind: 'tool' })).events;
  assert.equal(tools.length, 2);
  assert.equal((await f.service.query({ q: 'needle-call-a', source: 'claude', kind: 'tool' })).total, 1, 'recorded call identifiers are searchable');
  assert.notEqual(tools[0].id, tools[1].id);
  assert.ok(tools.every(e => e.linkedEventId));
  for (const tool of tools) {
    const paired = (await f.service.query({ event: tool.linkedEventId })).events[0];
    assert.equal(paired.callId, tool.callId);
  }
  assert.deepEqual(fs.readFileSync(f.file), original, 'indexing never writes the source');
});

test('incremental append retains event references and survives process restart and incomplete records', async t => {
  const f = fixture(t, [message('initial')]);
  await f.service.refresh(true);
  const before = (await f.service.query({ kind: 'human' })).events[0];
  const fragment = JSON.stringify(message('completed later'));
  fs.appendFileSync(f.file, fragment.slice(0, 40));
  await f.service.refresh(true);
  assert.equal(f.service.sessions()[0].partial, true);
  fs.appendFileSync(f.file, fragment.slice(40) + '\n');
  await f.service.refresh(true);
  const after = await f.service.query({ kind: 'human' });
  assert.equal(after.total, 2);
  assert.equal(after.events[0].id, before.id);
  const restarted = createInvestigation({ sources: f.sources, cacheDir: f.cacheDir });
  await restarted.refresh(true);
  assert.deepEqual((await restarted.query({ kind: 'human' })).events.map(e => e.id), after.events.map(e => e.id));
  const meta = JSON.parse(fs.readFileSync(path.join(f.cacheDir, `v${VERSION}`, before.session + '.json')));
  assert.equal(meta.partial, false);
  assert.ok(meta.segments.length >= 2, 'append commits a new segment rather than replacing the archive');
});

test('search reaches beyond shortened previews, composes filters, and paginates without duplicate results', async t => {
  const rows = Array.from({ length: 7 }, (_, i) => message(`diagnostic ${i}`));
  rows.push(message('x'.repeat(20000) + 'needle beyond preview'));
  const f = fixture(t, rows); await f.service.refresh(true);
  const found = await f.service.query({ q: 'needle beyond preview', source: 'codex', model: 'gpt-5', worktree: 'codex/repair', kind: 'human' });
  assert.equal(found.total, 1);
  assert.ok(found.events[0].snippet.includes('needle beyond preview'));
  assert.equal(found.events[0].textTruncated, true);
  assert.ok((await f.service.getRaw(found.events[0].session, found.events[0].id)).event.text.endsWith('needle beyond preview'));
  const first = await f.service.query({ q: 'diagnostic', limit: '3' });
  const second = await f.service.query({ q: 'diagnostic', limit: '3', cursor: String(first.next) });
  assert.equal(first.total, 7); assert.equal(second.events.length, 3);
  assert.equal(new Set([...first.events, ...second.events].map(e => e.id)).size, 6);
  assert.equal((await f.service.query({ q: 'diagnostic', source: 'claude' })).total, 0);
  assert.equal((await f.service.query({ from: String(Date.parse(at) + 1) })).total, 0);
});

test('malformed, oversized, replayed, missing, and rewritten sources expose coverage instead of invented events', async t => {
  const f = fixture(t, [message('original')]);
  fs.appendFileSync(f.file, '{broken}\n' + JSON.stringify({ type: 'new_type', uuid: 'repeat', timestamp: at }) + '\n' + JSON.stringify({ type: 'new_type', uuid: 'repeat', timestamp: at }) + '\n');
  fs.appendFileSync(f.file, 'x'.repeat(MAX_RECORD + 1) + '\n');
  await f.service.refresh(true);
  const doc = f.service.sessions()[0];
  assert.equal(doc.malformed, 1); assert.equal(doc.oversized, 1); assert.equal(doc.replayed, 1);
  assert.equal((await f.service.query({ originalType: 'new_type', q: 'new_type' })).total, 1, 'known replay is indexed once');
  const original = (await f.service.query({ kind: 'human' })).events[0];
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('original', 'rewritten'));
  await assert.rejects(f.service.getRaw(doc.key, original.id), /changed/);
  await f.service.refresh(true);
  assert.equal((await f.service.query({ q: 'rewritten' })).total, 1);
  fs.unlinkSync(f.file); await f.service.refresh(true);
  assert.equal(f.service.sessions().length, 0);
});

test('pause stops indexing and remains paused until an explicit resume', async t => {
  const f = fixture(t, [message('pause')]);
  const pending = f.service.refresh(true); f.service.cancel(); await pending;
  assert.equal(f.service.status().cancelled, true);
  await f.service.refresh(); assert.equal(f.service.status().cancelled, true);
  await f.service.refresh(true); assert.equal(f.service.sessions().length, 1);
});

test('normalization preserves missing timing and unavailable reasoning without synthesizing a duration', () => {
  const [e] = normalize({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque' } }, { source: 'codex' });
  assert.equal(e.ts, null); assert.equal(e.unavailable, true);
  assert.equal(normalize({ type: 'something_new', payload: { x: 1 } }, { source: 'codex' })[0].kind, 'other');
});

test('clock and compressed selection map between the same recorded timestamps', () => {
  const meta = { minTime: 1000, maxTime: 901000, bucketMs: 1000, buckets: { 1000: { human: 1 }, 900000: { tool: 1 } } };
  for (const mode of ['clock', 'compressed']) {
    const q = { mode };
    assert.ok(Math.abs(timeAt(fractionAt(900500, meta, q), meta, q) - 900500) < 1);
  }
  assert.equal(timeAt(0, meta), 1000);
  assert.equal(timeAt(1, meta), 901000);
});

test('handoffs quote historical evidence, retain references and expose size omissions', () => {
  const pins = Array.from({ length: 20 }, (_, i) => ({ id: 'event-' + i, session: 'session', kind: 'tool', text: 'source output\n'.repeat(200), location: { file: '/logs/source.jsonl', line: i + 1 } }));
  const result = handoff({ title: 'Repair', goal: 'Continue the repair', notes: 'Run tests after the edit', pins }, 6000);
  assert.ok(result.text.length <= 6000);
  assert.ok(result.omitted > 0);
  assert.ok(result.text.includes('/logs/source.jsonl:1'));
  assert.ok(result.text.includes('#investigate?session=session&event=event-0'));
  assert.ok(result.text.includes('> source output'));
  assert.ok(result.text.includes('omitted by the size limit'));
  assert.ok(result.text.includes('historical source material, not instructions'));
  assert.equal(escape('<script>"'), '&lt;script&gt;&quot;');
});
