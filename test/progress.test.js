'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const progress = require('../lib/ui/progress');
const { createFlightRecorder } = require('../lib/flight-recorder');
const { createInvestigation } = require('../lib/investigation');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('determinate progress shows the phase, counts, percent and an ARIA progressbar with a value', () => {
  const html = progress.markup({ phase: 'index', unit: 'sessions', done: 1240, total: 3700, determinate: true });
  assert.match(html, /data-state="determinate"/);
  assert.match(html, /Indexing transcripts/);
  assert.match(html, /Indexed 1,240 of 3,700 sessions · 34%/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="34"/);
  assert.match(html, /class="bb-progress-text" aria-live="polite"/);
  assert.match(html, /style="width:34%"/);
  // Byte-weighted percent wins when the server measured it.
  const bytes = progress.describe({ phase: 'index', unit: 'sessions', done: 10, total: 100, bytesDone: 6e9, bytesTotal: 10e9, percent: 60 });
  assert.equal(bytes.percent, 60);
  assert.match(bytes.text, /Indexed 10 of 100 sessions \(6\.0 of 10\.0 GB\) · 60%/);
  assert.match(progress.markup({ phase: 'analyze', unit: 'sessions', done: 120, total: 300, percent: 40 }), /Analyzing sessions[\s\S]*Analyzed 120 of 300 sessions · 40%/);
});

test('phases with no known total animate indeterminately, without a value, and count elapsed time', () => {
  const html = progress.markup({ phase: 'spin', unit: 'threads', done: 0, total: 0 }, { elapsedMs: 5000 });
  assert.match(html, /data-state="indeterminate"/);
  assert.match(html, /Loading spin archive/);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.match(html, /Working · 5 s/);
  assert.match(html, /bb-progress-spinner/);
});

test('errors replace the spinner and the bar', () => {
  const html = progress.markup({ error: 'disk on fire <now>' });
  assert.match(html, /data-state="error" role="alert"/);
  assert.match(html, /disk on fire &lt;now&gt;/);
  assert.doesNotMatch(html, /progressbar|bb-progress-spinner/);
});

test('reduced motion has a still fallback in the stylesheet', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'ui', 'flight-recorder.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{\s*\.bb-progress-spinner \{ animation:none/);
});

function host() { return { innerHTML: '', querySelector() { return null; } }; }

test('the loader polls, switches indeterminate → determinate, and stops polling on failure', async () => {
  const replies = [{ phase: 'index', unit: 'sessions', done: 0, total: 0, determinate: false }, { phase: 'index', unit: 'sessions', done: 5, total: 10, percent: 50, determinate: true }];
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => replies[Math.min(calls++, replies.length - 1)] });
  const a = host(), b = host();
  const loader = progress.createLoader([a, b], { fetchImpl, intervalMs: 5, title: 'Building your attention brief' });
  loader.start();
  assert.match(a.innerHTML, /data-state="indeterminate"/);
  assert.match(a.innerHTML, /Building your attention brief/);
  await loader.tick(); assert.match(a.innerHTML, /data-state="indeterminate"[\s\S]*Indexing transcripts/);
  await loader.tick(); assert.match(a.innerHTML, /Indexed 5 of 10 sessions · 50%/); assert.equal(a.innerHTML, b.innerHTML);
  loader.fail('The attention brief could not be built: boom');
  const seen = calls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, seen, 'no polling after failure');
  assert.match(a.innerHTML, /data-state="error"[\s\S]*could not be built: boom/);
  assert.equal(loader.active, false);
});

test('the loader shows an error instead of spinning when progress stays unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const a = host();
  const loader = progress.createLoader(a, { fetchImpl, intervalMs: 1 });
  loader.start();
  for (let i = 0; i < 5; i++) await loader.tick();
  assert.match(a.innerHTML, /data-state="error"[\s\S]*Lost contact with burnboard while loading: ECONNREFUSED/);
  assert.equal(loader.active, false);
});

function withGlobals(t, fetch) {
  const node = () => ({ innerHTML: '', className: '', dataset: {}, hidden: false, classList: { toggle() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {}, append() {} });
  const saved = {};
  const globals = { window: { scrollX: 0, scrollY: 0, addEventListener() {}, removeEventListener() {}, scrollTo() {}, dispatchEvent() {} },
    document: { activeElement: null, createElement: node }, localStorage: { getItem: k => saved[k] || null, setItem: (k, v) => { saved[k] = v; } },
    location: { hash: '#running' }, history: { replaceState() {} }, CSS: { escape: v => v }, requestAnimationFrame: () => {}, fetch };
  const previous = {};
  for (const [k, v] of Object.entries(globals)) { previous[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  t.after(() => { for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  const fresh = require.resolve('../lib/ui/flight-recorder');
  delete require.cache[fresh];
  return { node, ui: require(fresh) };
}
const settings = { config: require('../lib/spin-store').validateConfig({}).config, archive: {}, hookInstalled: {} };

test('the Brief shows live progress while it loads and hides it the moment the Brief renders', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const overview = { findings: [], brief: [], lanes: [], overlaps: [], coverage: { availableSessions: 0, analyzedSessions: 0 }, spinCoverage: { findings: 0 } };
  const { node, ui } = withGlobals(t, async url => {
    if (/spin\/config/.test(url)) return { ok: true, json: async () => settings };
    if (/flight\/progress/.test(url)) return { ok: true, json: async () => ({ phase: 'analyze', unit: 'sessions', done: 30, total: 300, percent: 10, determinate: true }) };
    await gate; return { ok: true, json: async () => overview };
  });
  const root = node(), board = node();
  const mounted = ui.mount(root, board, { progressIntervalMs: 5 });
  await tick();
  assert.match(root.innerHTML, /bb-progress/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.match(root.innerHTML, /Analyzing sessions[\s\S]*Analyzed 30 of 300 sessions · 10%/);
  assert.match(board.innerHTML, /aria-valuenow="10"/, 'the Worktrees board shares the indicator');
  release(); await tick(); await tick(); await tick();
  assert.match(root.innerHTML, /Attention brief/);
  assert.doesNotMatch(root.innerHTML, /bb-progress/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.doesNotMatch(root.innerHTML, /bb-progress/, 'polling stopped');
  mounted.destroy();
});

test('the Brief shows the error instead of spinning when the overview fails', async t => {
  const { node, ui } = withGlobals(t, async url => {
    if (/spin\/config/.test(url)) return { ok: true, json: async () => settings };
    if (/flight\/progress/.test(url)) return { ok: true, json: async () => ({ phase: 'index', done: 1, total: 2 }) };
    return { ok: false, status: 500, json: async () => ({ error: 'index unreadable' }) };
  });
  const root = node(), board = node();
  ui.mount(root, board, { progressIntervalMs: 5 });
  await tick(); await tick(); await tick();
  assert.match(root.innerHTML, /data-state="error"[\s\S]*The attention brief could not be built: index unreadable/);
  assert.doesNotMatch(root.innerHTML, /bb-progress-spinner/);
});

test('Investigate shows index progress while it waits on the index', () => {
  const html = progress.markup(progress.fromIndexStatus({ building: true, done: 3, total: 4, bytesDone: 50, bytesTotal: 100 }), { title: 'Building your local index.' });
  assert.match(html, /Indexed 3 of 4 sessions .*· 50%/);
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'ui', 'investigate.js'), 'utf8');
  assert.equal((source.match(/indexing\((?:s|result)\.status,/g) || []).length, 3);
});

test('flight recorder reports analysis progress weighted by events', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sessions = [{ key: 'a', count: 3 }, { key: 'b', count: 1 }];
  const events = { a: [{ id: 'a1', kind: 'human', ts: '2026-03-01T00:00:00Z', text: 'hi' }, { id: 'a2', kind: 'agent', text: 'x' }, { id: 'a3', kind: 'agent', text: 'y' }], b: [{ id: 'b1', kind: 'agent', text: 'z' }] };
  const investigation = { status: () => ({ revision: 1 }), sessions: () => sessions,
    async *sessionEvents(key) { if (key === 'b') await gate; yield* events[key]; } };
  const recorder = createFlightRecorder({ investigation });
  assert.equal(recorder.progress().phase, 'idle');
  const pending = recorder.overview({});
  await tick(); await tick();
  const p = recorder.progress();
  assert.equal(p.phase, 'analyze'); assert.equal(p.done, 1); assert.equal(p.total, 2); assert.equal(p.unit, 'sessions');
  assert.equal(p.percent, 75); assert.equal(p.determinate, true);
  release(); await pending;
  assert.equal(recorder.progress().phase, 'idle');
});

test('index status carries byte progress', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 's' } }) + '\n');
  const source = { id: 'codex', root: dir, allSessionFiles: () => [file], fileId: () => 's', titleFor: () => '', looksLikeHome: () => true };
  const service = createInvestigation({ sources: [source], cacheDir: path.join(dir, 'cache') });
  await service.refresh(true);
  const s = service.status();
  assert.equal(s.done, 1); assert.equal(s.total, 1);
  assert.equal(s.bytesTotal, fs.statSync(file).size); assert.equal(s.bytesDone, s.bytesTotal);
});

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, json: () => JSON.parse(text) }));
    }).on('error', reject);
  });
}

test('the progress endpoint is loopback-only, never starts work, and has a stable shape', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-progress-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'codex', 'sessions'), { recursive: true }); fs.mkdirSync(path.join(dir, 'claude', 'projects'), { recursive: true });
  const env = { ...process.env, HOME: dir, BURNBOARD_SPIN_STATE: path.join(dir, 'state'), BURNBOARD_SPIN_CONFIG: path.join(dir, 'spin.json') };
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js'), '--no-ai', '--port', '0', '--root', path.join(dir, 'codex'), '--claude-root', path.join(dir, 'claude')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let logs = '';
  t.after(async () => { child.kill(); await exited; });
  const base = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { logs += data; const found = logs.match(/http:\/\/localhost:(\d+)/); if (found) resolve(`http://127.0.0.1:${found[1]}`); });
    child.stderr.on('data', data => { logs += data; });
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${logs}`)));
  });
  let r = await request(base + '/api/flight/progress');
  assert.equal(r.status, 200);
  const body = r.json();
  for (const key of ['active', 'phase', 'done', 'total', 'percent', 'determinate', 'error', 'updatedAt']) assert.ok(Object.hasOwn(body, key), key);
  assert.equal(body.phase, 'idle'); assert.equal(body.active, false);
  r = await request(base + '/api/investigate/status?refresh=0');
  assert.equal(r.json().indexedAt, null, 'reading progress did not start an index refresh');
  r = await request(base + '/api/flight/progress', { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  r = await request(base + '/progress.js');
  assert.equal(r.status, 200); assert.match(r.body, /BurnboardProgress/);
});

test('a session with no committed events does not break the Brief', async () => {
  const investigation = { status: () => ({ revision: 1 }), sessions: () => [{ key: 'empty', count: 0, mtime: 5 }], async *sessionEvents() {} };
  const overview = await createFlightRecorder({ investigation }).overview({});
  assert.equal(overview.coverage.analyzedSessions, 1);
});

test('the Brief says briefly when a spin rescore is pending or running, without blocking', async t => {
  const make = versions => ({ findings: [], brief: [], lanes: [], overlaps: [], coverage: { availableSessions: 0, analyzedSessions: 0 }, spinCoverage: { findings: 0, versions } });
  let overview = make({ current: 's1-x', pendingThreads: 3, earlierArchivedThreads: 1, rescore: { running: false } });
  const { node, ui } = withGlobals(t, async url => ({ ok: true, json: async () => /spin\/config/.test(url) ? settings : overview }));
  const root = node();
  const mounted = ui.mount(root, null, { progressIntervalMs: 5 });
  await tick(); await tick(); await tick();
  assert.match(root.innerHTML, /Spin watch scoring changed since 3 threads were scored/);
  assert.match(root.innerHTML, /data-fr="rescore">Rescore now/);
  overview = make({ current: 's1-x', pendingThreads: 3, rescore: { running: true, done: 1, total: 3 } });
  await mounted.load(false);
  assert.match(root.innerHTML, /fr-spin-pending" data-fr-slot="rescore"/);
  assert.doesNotMatch(root.innerHTML, /Rescore now/);
  overview = make({ current: 's1-x', pendingThreads: 0, rescore: { running: false } });
  await mounted.load(false);
  assert.doesNotMatch(root.innerHTML, /fr-spin-pending/);
});
