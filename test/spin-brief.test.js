'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const store = require('../lib/spin-store');
const { createSpinBrief, toFinding, nestUnderSpin, investigationKey } = require('../lib/spin-brief');
const { createFlightRecorder, RULES } = require('../lib/flight-recorder');
const ui = require('../lib/ui/flight-recorder');

const start = Date.parse('2026-03-02T12:00:00Z');
const stamp = seconds => new Date(start + seconds * 1000).toISOString();

function archiveDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-brief-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = store.paths({ stateDir: path.join(dir, 'state'), codexHome: path.join(dir, '.codex'), claudeHome: path.join(dir, '.claude') });
  const live = path.join(dir, 'rollout-live.jsonl'); fs.writeFileSync(live, '{}\n');
  const episode = (id, file, extra = {}) => ({
    v: 1, threadId: id, source: extra.source || 'codex', file, cwd: '/repo/.worktrees/a/b', repo: 'app', title: `Thread ${id}`, firstRequest: 'Finish review round 13',
    isRoot: true, root: id, lastSeen: start + 3600000, episodes: [{ id: `codex-${id}-${start}`, start, peakT: start + 1800000, end: extra.end === undefined ? start + 3600000 : extra.end, endReason: 'calm',
      peakScore: 0.91, peakLevel: extra.level || 'alert', reasons: ['review round 42', 'same command 7 times in a row', '1 new file in the last 120 actions'], roundEvidence: { round: 42, text: 'Starting review round 42 now.' },
      lastHotT: start + 3600000, history: [[start, 0.71, 'watch'], [start + 1800000, 0.91, 'alert'], [start + 3600000, 0.6, 'alert']],
      trail: [{ t: start + 60000, op: 'cmd', cmd: 'node scripts/review.mjs next --pr N', outcome: 'ok', ceremony: true }, { t: start + 120000, op: 'edit', file: 'src/a.ts' }],
      humans: [{ t: start + 3000000, text: 'are you spinning your wheels?', who: 'user' }], callouts: extra.callouts || [], merged: null }],
    callouts: [], misses: [], label: extra.label || null,
  });
  fs.mkdirSync(p.episodesDir, { recursive: true });
  return { dir, p, live, write: (id, file, extra) => store.atomicWrite(store.episodePath(p, extra && extra.source || 'codex', id), episode(id, file, extra)) };
}

test('spin rule maps archived episodes onto the finding shape', t => {
  const a = archiveDir(t);
  a.write('live', a.live);
  a.write('gone', path.join(a.dir, 'deleted.jsonl'), { level: 'watch', callouts: [{ t: start + 3000000, text: "you're churning" }] });
  const brief = createSpinBrief({ paths: a.p });
  const findings = brief.findings({ since: start, now: start + 7200000 });
  assert.equal(findings.length, 2);
  const live = findings.find(f => f.sessionId === 'live'), gone = findings.find(f => f.sessionId === 'gone');
  assert.equal(RULES[0], 'spin');
  assert.equal(live.rule, 'spin'); assert.equal(live.severity, 'high');
  assert.equal(live.title, 'Spin alert: review round 42 · same command 7 times in a row');
  assert.equal(live.trigger, 'review round 42; same command 7 times in a row; 1 new file in the last 120 actions');
  assert.equal(live.session, investigationKey('codex', a.live));
  assert.match(live.rationale, /churn-like pattern/); assert.match(live.uncertainty, /not proof/);
  assert.equal(live.evidence[0].session, live.session);
  assert.match(ui.investigationUrl(live), /^#investigate\?session=/);
  assert.equal(gone.severity, 'medium');
  assert.equal(gone.spin.transcriptDeleted, true);
  assert.equal(gone.spin.outcome, 'user called it out');
  assert.equal(gone.session, 'spin:codex:gone');
  assert.equal(brief.findings({ since: start + 86400000, now: start + 90000000 }).length, 0, 'interval filter applies');
  assert.equal(brief.summary({ now: start + 7200000 }).count, 2);
});

test('one card per session: other findings in the spin span nest under it; other sessions render as before', async t => {
  const a = archiveDir(t);
  a.write('live', a.live);
  const key = investigationKey('codex', a.live);
  const tool = (id, s, callId, cmd) => ({ id, ts: stamp(s), kind: 'tool', text: JSON.stringify({ cmd }), callId, name: 'exec_command' });
  const result = (id, s, callId, text) => ({ id, ts: stamp(s), kind: 'result', text, callId });
  const repeated = s => [tool(`t${s}`, s, `c${s}`, 'git status'), result(`r${s}`, s + 1, `c${s}`, 'clean')];
  const records = new Map([[key, [...repeated(100), ...repeated(200), ...repeated(300)]], ['other', [...repeated(100), ...repeated(200), ...repeated(300)]]]);
  const sessions = [{ key, id: 'live', source: 'codex', repo: 'app', cwd: '/repo/.worktrees/a/b', title: 'Indexed title', minTime: start, maxTime: start + 3600000, mtime: start + 3600000 },
    { key: 'other', id: 'other', source: 'codex', repo: 'app', cwd: '/repo', title: 'Other', minTime: start, maxTime: start + 3600000, mtime: start + 3600000 }];
  const investigation = { status: () => ({ revision: 1 }), sessions: () => sessions, async *sessionEvents(k) { yield* records.get(k); } };
  const recorder = createFlightRecorder({ investigation, spin: createSpinBrief({ paths: a.p }), now: () => start + 7200000 });
  const overview = await recorder.overview({ since: start });
  assert.equal(overview.findings[0].rule, 'spin');
  assert.equal(overview.findings[0].sessionTitle, 'Indexed title');
  assert.deepEqual(overview.findings[0].supporting.map(f => f.rule), ['repeated-command']);
  assert.ok(!overview.findings.slice(1).some(f => f.session === key), 'nested findings are not repeated as separate cards');
  assert.ok(overview.findings.some(f => f.session === 'other' && f.rule === 'repeated-command'), 'sessions without spin render as today');
  const { versions, ...coverage } = overview.spinCoverage;
  assert.deepEqual(coverage, { source: 'spin watch archive', findings: 1, archive: false, capped: false, nested: 1 });
  assert.equal(versions.rescore.running, false);
  assert.equal(overview.coverage.maxSessions, 300, 'Release Two coverage is unchanged');
  const off = await recorder.overview({ since: start, rules: 'repeated-command' });
  assert.ok(!off.findings.some(f => f.rule === 'spin'), 'the per-rule control turns spin off');
});

test('All time (archived) lists every episode, including deleted transcripts, and nothing else', async t => {
  const a = archiveDir(t);
  a.write('live', a.live);
  a.write('gone', path.join(a.dir, 'deleted.jsonl'), { source: 'claude', level: 'watch', label: { label: 'CHURN-LOOP', note: 'Re-ran the release gate' } });
  const investigation = { status: () => ({ revision: 1 }), sessions: () => [], async *sessionEvents() {} };
  const recorder = createFlightRecorder({ investigation, spin: createSpinBrief({ paths: a.p }), now: () => start + 400 * 86400000 });
  const overview = await recorder.overview({ since: 0, archive: '1' });
  assert.equal(overview.findings.length, 2);
  assert.ok(overview.findings.every(f => f.rule === 'spin' && f.spin.archived));
  const gone = overview.findings.find(f => f.sessionId === 'gone');
  assert.equal(gone.spin.transcriptDeleted, true);
  assert.equal(gone.spin.label.label, 'CHURN-LOOP');
  assert.equal(gone.spin.trail.length, 2);
  assert.equal(gone.spin.history.length, 3);
  assert.ok(overview.brief.length >= 1);
});

test('UI helpers: spin sorts first, hash focus, score sparkline, badge counts unacknowledged findings', () => {
  const list = [{ rule: 'long-wait', severity: 'high', to: 9 }, { rule: 'spin', severity: 'medium', to: 1 }, { rule: 'repeated-failure', severity: 'high', to: 5 }];
  assert.deepEqual(list.sort(ui.findingOrder).map(f => f.rule), ['spin', 'long-wait', 'repeated-failure']);
  assert.equal(ui.focusFromHash('#running?attention=spin'), 'spin');
  assert.equal(ui.focusFromHash('#running'), null);
  assert.match(ui.sparkline([[1, 0.5], [2, 0.9]]), /<svg class="fr-spark"/);
  assert.equal(ui.sparkline([[1, 0.5]]), '');
  const state = { dismissed: { b: 1 }, snoozed: { c: Date.now() + 60000 }, acknowledged: { d: 1 } };
  assert.deepEqual(ui.badgeCount({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }, state).map(i => i.id), ['a']);
  const form = ui.settingsForm(store.validateConfig({}).config, { archive: { episodes: 3, threads: 2, bytes: 1e6 }, hookInstalled: { codex: false, claude: true } });
  for (const field of ['desktop.enabled', 'desktop.minLevel', 'agentNudge.mode', 'thresholds.watch', 'thresholds.backToBackRepeat', 'episodes.retentionDays', 'claudeMaxLevel']) assert.ok(form.includes(`data-spin="${field}"`), field);
  assert.match(form, /Hook installed: Codex no, Claude Code yes/);
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('id="spinBadge"') && html.includes('href="#running?attention=spin"'));
  assert.ok(html.includes('BurnboardFlightRecorder.mountSpinBadge($(\'#spinBadge\'))'));
  assert.ok(fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'ui', 'flight-recorder.js'), 'utf8').includes('<option value="archive"'));
});

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

test('settings API is loopback-only, validates input, and the overview carries spin findings', { timeout: 20000 }, async t => {
  const a = archiveDir(t);
  a.write('live', a.live, { end: null });
  // shift the archived episode to "an hour ago" so it counts as recent
  const file = store.episodePath(a.p, 'codex', 'live'), shift = Date.now() - start - 3600000;
  const moved = JSON.parse(fs.readFileSync(file, 'utf8'), (key, value) => typeof value === 'number' && value >= start && value < start + 86400000 ? value + shift : value);
  store.atomicWrite(file, moved);
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(a.dir, 'codex', 'sessions'), { recursive: true }); fs.mkdirSync(path.join(a.dir, 'claude', 'projects'), { recursive: true });
  const env = { ...process.env, HOME: a.dir, BURNBOARD_SPIN_STATE: a.p.stateDir, BURNBOARD_SPIN_CONFIG: path.join(a.dir, 'spin.json') };
  const child = spawn(process.execPath, [path.join(root, 'server.js'), '--no-ai', '--port', '0', '--root', path.join(a.dir, 'codex'), '--claude-root', path.join(a.dir, 'claude')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let logs = '';
  t.after(async () => { child.kill(); await exited; });
  const base = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { logs += data; const found = logs.match(/http:\/\/localhost:(\d+)/); if (found) resolve(`http://127.0.0.1:${found[1]}`); });
    child.stderr.on('data', data => { logs += data; });
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${logs}`)));
  });
  let r = await request(base + '/api/spin/config');
  assert.equal(r.status, 200);
  const info = r.json();
  assert.equal(info.config.agentNudge.mode, 'shadow');
  assert.equal(info.archive.episodes, 1);
  const json = { 'Content-Type': 'application/json' };
  r = await request(base + '/api/spin/config', { method: 'PUT', headers: json, body: JSON.stringify({ ...info.config, desktop: { ...info.config.desktop, enabled: false }, agentNudge: { mode: 'nudge', minLevel: 'alert' } }) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(env.BURNBOARD_SPIN_CONFIG, 'utf8')).agentNudge.mode, 'nudge');
  r = await request(base + '/api/spin/config', { method: 'PUT', headers: json, body: JSON.stringify({ thresholds: { watch: 2 } }) });
  assert.equal(r.status, 400);
  r = await request(base + '/api/spin/config', { method: 'PUT', body: '{}' });
  assert.equal(r.status, 415);
  r = await request(base + '/api/spin/config', { method: 'PUT', headers: { ...json, Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  r = await request(base + '/api/spin/summary');
  assert.equal(r.status, 200);
  assert.equal(r.json().count, 1);
  r = await request(base + '/api/flight/overview?' + new URLSearchParams({ since: String(Date.now() - 8 * 3600000), refresh: '0' }));
  assert.equal(r.status, 200);
  const overview = r.json();
  assert.equal(overview.findings[0].rule, 'spin');
  assert.equal(overview.spinCoverage.capped, false);
});

test('nestUnderSpin keeps findings outside the spin span at top level', () => {
  const spinFinding = { session: 's', from: 1000, to: 2000 };
  const inside = { session: 's', from: 1500, to: 1600 }, outside = { session: 's', from: 1e9, to: 1e9 + 1 }, other = { session: 'x', from: 1500, to: 1600 };
  assert.deepEqual(nestUnderSpin([spinFinding], [inside, outside, other]), [outside, other]);
  assert.deepEqual(spinFinding.supporting, [inside]);
  assert.equal(toFinding({ threadId: 'x', source: 'codex', file: null, lastSeen: 5 }, { id: 'e', start: 1, peakLevel: 'watch', reasons: [] }, { now: 10 }).title, 'Spin watch: sustained churn-like pattern');
});

// Renders the Attention Brief in a stubbed browser and returns its root node.
async function mountBrief(t, overview, hash = '#running', savedState = null) {
  const node = () => {
    const listeners = {};
    return { innerHTML: '', className: '', dataset: {}, hidden: false, listeners, classList: { toggle() {} },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {}, append() {} };
  };
  const root = node(), board = node();
  const saved = savedState ? { 'burnboard.flight-recorder.v1': JSON.stringify(savedState) } : {};
  const globals = { window: { scrollX: 0, scrollY: 0, addEventListener() {}, removeEventListener() {}, scrollTo() {}, dispatchEvent() {} },
    document: { activeElement: null, createElement: node }, localStorage: { getItem: k => saved[k] || null, setItem: (k, v) => { saved[k] = v; } },
    location: { hash }, history: { replaceState() {} }, CSS: { escape: v => v }, requestAnimationFrame: () => {},
    fetch: async url => ({ ok: true, json: async () => /spin\/config/.test(url) ? { config: store.validateConfig({}).config, archive: {}, hookInstalled: {} } : overview }) };
  const previous = {};
  for (const [k, v] of Object.entries(globals)) { previous[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  const fresh = require.resolve('../lib/ui/flight-recorder');
  delete require.cache[fresh];
  const mounted = require(fresh).mount(root, board);
  t.after(() => { mounted.destroy(); for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  root.action = (action, id) => {
    const target = { dataset: { fr: action, ...(id ? { id } : {}) }, closest() { return this; } };
    for (const listener of root.listeners.click || []) listener({ target });
  };
  root.savedState = () => JSON.parse(saved['burnboard.flight-recorder.v1']);
  return root;
}

test('the Brief renders a spin card with nested findings, deleted-transcript note, and settings slot', async t => {
  const a = archiveDir(t);
  a.write('gone', path.join(a.dir, 'deleted.jsonl'), { callouts: [{ t: start + 3000000, text: "you're churning" }] });
  const brief = createSpinBrief({ paths: a.p });
  const [spinFinding] = brief.findings({ since: 0, now: start + 7200000 });
  spinFinding.supporting = [{ id: 'nested-1', rule: 'repeated-command', severity: 'low', title: 'Equivalent command and result repeated', rationale: 'r', uncertainty: 'u', trigger: '3 pairs', evidence: [], evidenceCount: 6, session: spinFinding.session, from: start, to: start + 1 }];
  const titled = { ...spinFinding, id: 'titled-spin', session: 'spin:codex:t1', sessionId: '019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', sessionTitle: 'Move the docs site to its new domain', repo: 'https://github.com/example/app', supporting: [] };
  const untitled = { ...spinFinding, id: 'untitled-spin', session: 'spin:codex:t2', sessionId: '019a9999-aaaa-bbbb-cccc-ddddeeeeffff', sessionTitle: '019a9999-aaaa-bbbb-cccc-ddddeeeeffff', supporting: [] };
  const overview = { findings: [spinFinding, titled, untitled, { id: 'plain', rule: 'long-wait', severity: 'medium', title: 'Recorded call still has no result', rationale: 'r', uncertainty: 'u', trigger: 't', evidence: [], evidenceCount: 1, session: 'other', from: start, to: start + 5 }],
    brief: [{ repo: 'app', cwd: '/repo', sessions: 1, findings: 2 }], lanes: [], overlaps: [], coverage: { availableSessions: 1, analyzedSessions: 1 }, spinCoverage: { findings: 1 } };
  const root = await mountBrief(t, overview, '#running?attention=spin');
  assert.match(root.innerHTML, /fr-finding fr-spin severity-high/);
  assert.match(root.innerHTML, /Spin alert: review round 42 · same command 7 times in a row/);
  assert.match(root.innerHTML, /Matched current-round statement: “Starting review round 42 now\.”/);
  // The thread name is the heading, then agent · path, then the reasons line.
  assert.match(root.innerHTML, /<h3 class="fr-spin-thread">Move the docs site to its new domain<\/h3>\s*<div class="fr-finding-body">\s*<p class="fr-spin-session">Codex · https:\/\/github\.com\/example\/app<\/p>\s*<p class="fr-spin-reasons">Spin alert: review round 42 · same command 7 times in a row<\/p>/);
  assert.match(root.innerHTML, /<h3 class="fr-spin-thread">Thread gone<\/h3>\s*<div class="fr-finding-body">\s*<p class="fr-spin-session">Codex · app<\/p>\s*<p class="fr-spin-reasons">Spin alert:/);
  // An untitled thread falls back to a short session id, never an empty heading.
  assert.match(root.innerHTML, /<h3 class="fr-spin-thread">Session 019a9999-aaaa<\/h3>/);
  // Every spin card gets the spin layout, not just the first one in the list.
  assert.equal(root.innerHTML.match(/fr-finding fr-spin /g).length, 3);
  assert.doesNotMatch(root.innerHTML, /<h3[^>]*>Spin alert/, 'reasons are no longer the spin card heading');
  assert.match(root.innerHTML, /The transcript was deleted/);
  assert.match(root.innerHTML, /You called it out: “you&#39;re churning”/);
  assert.match(root.innerHTML, /1 supporting finding from other rules in the same session/);
  assert.match(root.innerHTML, /Equivalent command and result repeated/);
  assert.match(root.innerHTML, /Showing spin watch only/);
  assert.doesNotMatch(root.innerHTML, /Recorded call still has no result/, 'focus mode shows the spin rule only');
  assert.match(root.innerHTML, /<option value="archive"/);
  assert.match(root.innerHTML, /data-fr-slot="spin-settings"/);
  assert.match(root.innerHTML, /<svg class="fr-spark"/);
  // One "Spin watch" subheading carries the rule name; the cards no longer repeat it.
  assert.match(root.innerHTML, /<div class="fr-subheading" data-fr-group="spin"><span class="fr-eyebrow">Churning agents<\/span><h3>Spin watch<\/h3><p>3 threads<\/p><\/div>/);
  assert.equal(root.innerHTML.match(/data-fr-group="spin"/g).length, 1);
  assert.doesNotMatch(root.innerHTML, /<span class="fr-rule">Spin watch/);
  assert.doesNotMatch(root.innerHTML, /data-fr-group="other"/, 'the spin-only view has no other findings');
});

// A minimal spin finding at the given level, as the server sends it.
const spinCard = (id, level, extra = {}) => ({ id, rule: 'spin', severity: level === 'alert' ? 'high' : 'medium', title: `Spin ${level}: review round 9`, rationale: 'r', uncertainty: 'u', trigger: 't', evidence: [], evidenceCount: 1,
  session: `spin:codex:${id}`, sessionId: id, sessionTitle: `Thread ${id}`, from: start, to: start + 10, spin: { level, peakLevel: level, peakScore: 0.8, source: 'codex', outcome: 'active', trail: [], history: [] }, ...extra });
const plainFinding = id => ({ id, rule: 'long-wait', severity: 'medium', title: `Recorded call ${id} still has no result`, rationale: 'r', uncertainty: 'u', trigger: 't', evidence: [], evidenceCount: 1, session: id, from: start, to: start + 5 });
const briefOf = findings => ({ findings, brief: [], lanes: [], overlaps: [], coverage: { availableSessions: 1, analyzedSessions: 1 } });
const cardTop = (html, id) => html.match(new RegExp(`data-finding="${id}">\\s*<div class="fr-finding-top">([\\s\\S]*?)</div>`))[1];

test('spin card kickers: no "watch" level word, an Alert marker on alert cards, the activity state kept', async t => {
  const root = await mountBrief(t, briefOf([spinCard('w1', 'watch'), spinCard('a1', 'alert')]));
  const watchTop = cardTop(root.innerHTML, 'w1'), alertTop = cardTop(root.innerHTML, 'a1');
  assert.doesNotMatch(watchTop, /watch/i, 'no level word and no rule name on a watch card');
  assert.doesNotMatch(watchTop, /fr-alert-marker/);
  assert.match(alertTop, /<span class="fr-severity fr-alert-marker">Alert<\/span>/);
  assert.doesNotMatch(alertTop, /Spin watch/);
  for (const top of [watchTop, alertTop]) assert.match(top, /<span class="fr-outcome" data-fr-outcome="[^"]+">active<\/span>/);
  assert.match(root.innerHTML, /fr-finding fr-spin severity-high/, 'alert cards keep the alert border');
});

test('spin and other findings each get a subheading with a count', async t => {
  const root = await mountBrief(t, briefOf([spinCard('s1', 'watch'), spinCard('s2', 'alert'), plainFinding('p1'), plainFinding('p2')]));
  const html = root.innerHTML;
  assert.match(html, /<h3>Spin watch<\/h3><p>2 threads<\/p>/);
  assert.match(html, /<div class="fr-subheading" data-fr-group="other"><span class="fr-eyebrow">Other attention rules<\/span><h3>Other findings<\/h3><p>2 findings<\/p><\/div>/);
  // Order: Spin watch, its cards, Other findings, the other cards.
  const at = needle => html.indexOf(needle);
  assert.ok(at('data-fr-group="spin"') < at('data-finding="s1"'));
  assert.ok(Math.max(at('data-finding="s1"'), at('data-finding="s2"')) < at('data-fr-group="other"'));
  assert.ok(at('data-fr-group="other"') < at('data-finding="p1"'));
  // Non-spin cards still name their rule.
  assert.match(cardTop(html, 'p1'), /<span class="fr-rule">Long waits<\/span>/);
});

test('every Attention Brief card can collapse, with one control for all cards', async t => {
  const root = await mountBrief(t, briefOf([spinCard('s1', 'watch'), plainFinding('p1'), plainFinding('p2')]));
  assert.match(root.innerHTML, /data-fr="toggle-all-cards"[^>]*>Collapse all cards<\/button>/);
  assert.equal((root.innerHTML.match(/data-fr="toggle-card"/g) || []).length, 3);

  root.action('toggle-card', 's1');
  assert.match(root.innerHTML, /fr-finding fr-spin severity-medium is-collapsed" data-finding="s1"/);
  assert.match(cardTop(root.innerHTML, 's1'), /aria-expanded="false">Expand<\/button>/);
  assert.equal(root.savedState().collapsedFindings.s1, true, 'individual state persists');

  root.action('toggle-all-cards');
  assert.equal((root.innerHTML.match(/ is-collapsed" data-finding=/g) || []).length, 3);
  assert.match(root.innerHTML, /data-fr="toggle-all-cards"[^>]*>Expand all cards<\/button>/);

  root.action('toggle-all-cards');
  assert.equal((root.innerHTML.match(/ is-collapsed" data-finding=/g) || []).length, 0);
  assert.match(root.innerHTML, /data-fr="toggle-all-cards"[^>]*>Collapse all cards<\/button>/);
  assert.deepEqual(root.savedState().collapsedFindings, {});
});

test('with no spin cards the Brief shows no subheadings', async t => {
  const plain = await mountBrief(t, briefOf([plainFinding('p1')]));
  assert.doesNotMatch(plain.innerHTML, /fr-subheading/);
  assert.match(plain.innerHTML, /Recorded call p1 still has no result/);
});

test('the spin-only view keeps "Spin watch" over its empty state', async t => {
  const focused = await mountBrief(t, briefOf([plainFinding('p1')]), '#running?attention=spin');
  assert.match(focused.innerHTML, /<h3>Spin watch<\/h3><p>0 threads<\/p><\/div><div class="fr-clear">All clear/);
  assert.doesNotMatch(focused.innerHTML, /data-fr-group="other"/);
});

test('archived spin cards use the same subheading and count episodes per thread', async t => {
  const root = await mountBrief(t, briefOf([spinCard('e1', 'watch'), spinCard('e2', 'watch', { session: 'spin:codex:e1' }), spinCard('e3', 'alert')]), '#running', { range: 'archive' });
  assert.match(root.innerHTML, /every spin watch episode in the archive/, "rendered in the All time (archived) view");
  assert.match(root.innerHTML, /<h3>Spin watch<\/h3><p>3 episodes in 2 threads<\/p>/);
  assert.doesNotMatch(root.innerHTML, /<span class="fr-rule">Spin watch/);
});
