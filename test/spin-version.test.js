'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../lib/spin-store');
const version = require('../lib/spin-version');
const { createSpinBrief } = require('../lib/spin-brief');
const { plan } = require('../scripts/spin-backfill');
const { codex, healthyCodex, treadmillCodex } = require('./spin-helpers');

const BACKFILL = path.resolve(__dirname, '..', 'scripts', 'spin-backfill.js');
const HOOK = path.resolve(__dirname, '..', 'bin', 'spin-hook.js');
const LOOP = '0f0f0000-0000-7000-8000-00000000aaaa';
const GONE = '0f0f0000-0000-7000-8000-00000000bbbb';
const CALM = '0f0f0000-0000-7000-8000-00000000cccc';

function homes(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const day = path.join(dir, '.codex', 'sessions', '2026', '03', '02');
  fs.mkdirSync(day, { recursive: true }); fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
  const file = id => path.join(day, `rollout-2026-03-02T12-00-00-${id}.jsonl`);
  fs.writeFileSync(file(LOOP), treadmillCodex(LOOP, 240).join('\n') + '\n');
  fs.writeFileSync(file(GONE), treadmillCodex(GONE, 240).join('\n') + '\n');
  fs.writeFileSync(file(CALM), healthyCodex(CALM, 80).join('\n') + '\n');
  const configFile = path.join(dir, 'spin.json');
  const p = store.paths({ stateDir: path.join(dir, 'state'), codexHome: path.join(dir, '.codex'), claudeHome: path.join(dir, '.claude'), configFile });
  const env = { ...process.env, HOME: dir, BURNBOARD_SPIN_CONFIG: configFile, BURNBOARD_SPIN_STATE: p.stateDir };
  const backfill = (...extra) => {
    const run = spawnSync(process.execPath, [BACKFILL, '--state', p.stateDir, '--codex-home', p.codexHome, '--claude-home', p.claudeHome, '--workers', '2', '--quiet', '--json', ...extra], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim().split('\n').pop());
  };
  const setConfig = change => { const c = store.loadConfig(p); store.saveConfig(p, change(c)); };
  // Snapshot of every state and archive file: name → mtime + content.
  const snapshot = () => Object.fromEntries([p.sessionsDir, p.episodesDir].flatMap(d => fs.readdirSync(d).map(n => [path.join(d, n), `${fs.statSync(path.join(d, n)).mtimeMs}:${fs.readFileSync(path.join(d, n), 'utf8')}`])));
  return { dir, p, env, file, backfill, setConfig, snapshot };
}
const strip = value => JSON.parse(JSON.stringify(value, (key, v) => ['updatedAt', 'backfilledAt', 'outcome'].includes(key) ? undefined : v));

test('the scorer version covers scoring code, reference and scoring config, not display settings or comments', () => {
  const base = store.validateConfig({}).config;
  const v = version.scorerVersion(base);
  assert.match(v, /^s1-[0-9a-f]{12}$/);
  assert.equal(version.scorerVersion({ ...base, desktop: { enabled: false, minLevel: 'watch', cooldownMinutes: 1 }, agentNudge: { mode: 'nudge', minLevel: 'watch' },
    sources: { codex: true, claude: false }, episodes: { retentionDays: 30 }, dashboardUrl: 'http://localhost:9999', enabled: false }), v, 'display-only settings');
  assert.notEqual(version.scorerVersion({ ...base, thresholds: { ...base.thresholds, watch: 0.71 } }), v);
  assert.notEqual(version.scorerVersion({ ...base, claudeMaxLevel: 'alert' }), v);
  assert.notEqual(version.scorerVersion({ ...base, ceremonyPatterns: [...base.ceremonyPatterns, 'extra'] }), v);
  // Code hashing ignores line endings, comment-only lines and blank lines, but not code.
  const code = "'use strict';\n// a note\nconst x = 1;\n\nmodule.exports = x;\n";
  assert.equal(version.normalizeCode(code), version.normalizeCode(code.replace(/\n/g, '\r\n').replace('// a note', '// another note\n// more')));
  assert.notEqual(version.normalizeCode(code), version.normalizeCode(code.replace('= 1', '= 2')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-code-'));
  try {
    const lib = path.resolve(__dirname, '..', 'lib');
    fs.writeFileSync(path.join(dir, 'spin.js'), fs.readFileSync(path.join(lib, 'spin.js'), 'utf8').replace(/\n/g, '\r\n') + '\n// trailing comment\n');
    fs.copyFileSync(path.join(lib, 'spin-reference.json'), path.join(dir, 'spin-reference.json'));
    version._resetCache(); const a = version.codeHash(dir);
    version._resetCache(); const b = version.codeHash(lib);
    assert.equal(a, b, 'a CRLF checkout with an extra comment scores the same');
    fs.appendFileSync(path.join(dir, 'spin.js'), 'const changed = true;\n');
    version._resetCache(); assert.notEqual(version.codeHash(dir), b, 'a code change is a new version');
  } finally { version._resetCache(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unchanged transcripts are never rescored: not by the backfill, the Brief, or reading the archive', t => {
  const h = homes(t);
  const first = h.backfill();
  assert.equal(first.rescored, 3); assert.equal(first.rescoreReasons['new transcript'], 3);
  const before = h.snapshot();
  const second = h.backfill();
  assert.deepEqual([second.skipped, second.incremental, second.rescored, second.savedStates], [3, 0, 0, 0]);
  const brief = createSpinBrief({ paths: h.p });
  brief.findings({ since: 0, archive: true }); brief.findings({ since: 0 }); brief.summary();
  const v = brief.versions();
  assert.equal(v.pendingThreads, 0); assert.equal(v.earlierArchivedThreads, 0);
  assert.deepEqual(h.snapshot(), before, 'no state or archive file was rewritten');
  // Every state, episode and manifest entry records the scorer version.
  const scorer = version.scorerVersion(store.loadConfig(h.p));
  const manifest = store.readManifest(h.p);
  assert.equal(manifest.v, 2);
  assert.ok(Object.values(manifest.files).every(entry => entry.scorer === scorer && entry.offset === entry.size));
  assert.equal(store.loadState(h.p, 'codex', CALM).scorer, scorer);
  const archived = store.readJson(store.episodePath(h.p, 'codex', LOOP));
  assert.equal(archived.scorer, scorer);
  assert.ok(archived.episodes.length && archived.episodes.every(ep => ep.scorer === scorer));
});

test('a transcript the hook already consumed is skipped; a grown one is scored incrementally from its stored state', t => {
  const h = homes(t);
  h.backfill();
  const size = fs.statSync(h.file(LOOP)).size;
  const more = treadmillCodex(LOOP, 300).slice(481).join('\n') + '\n';
  fs.appendFileSync(h.file(LOOP), more);
  const scorer = version.scorerVersion(store.loadConfig(h.p));
  const planned = plan(h.p, [{ file: h.file(LOOP), source: 'codex' }], store.readManifest(h.p), scorer);
  assert.equal(planned.jobs.length, 1);
  assert.equal(planned.jobs[0].mode, 'resume');
  assert.equal(planned.jobs[0].state.offset, size, 'resumes at the stored byte offset');
  assert.equal(planned.jobs[0].work, Buffer.byteLength(more), 'reads only the appended bytes');
  const n = store.loadState(h.p, 'codex', LOOP).n;
  const run = h.backfill();
  assert.deepEqual([run.incremental, run.rescored, run.skipped], [1, 0, 2]);
  const after = store.loadState(h.p, 'codex', LOOP);
  assert.equal(after.n, n + 60, 'only the new actions were added to the stored state');
  assert.equal(after.offset, fs.statSync(h.file(LOOP)).size);
  // The live hook advancing a transcript counts as consumed, not rescored.
  fs.appendFileSync(h.file(CALM), codex.cmd(99999, 'node done.js') + '\n');
  const hook = spawnSync(process.execPath, [HOOK, '--source', 'codex'], { input: JSON.stringify({ session_id: CALM, turn_id: 't', transcript_path: h.file(CALM) }), env: h.env, encoding: 'utf8' });
  assert.equal(hook.status, 0);
  assert.equal(store.loadState(h.p, 'codex', CALM).offset, fs.statSync(h.file(CALM)).size);
  const again = h.backfill();
  assert.deepEqual([again.consumedByHook, again.incremental, again.rescored], [1, 0, 0]);
});

test('a scorer version change rescores existing transcripts once; archives without a transcript keep their version', t => {
  const h = homes(t);
  h.backfill();
  const oldScorer = version.scorerVersion(store.loadConfig(h.p));
  const goneFile = store.episodePath(h.p, 'codex', GONE);
  const goneBefore = store.readJson(goneFile);
  assert.ok(goneBefore.episodes.length);
  fs.rmSync(h.file(GONE));
  h.setConfig(c => ({ ...c, thresholds: { ...c.thresholds, watch: 0.69 } }));
  const newScorer = version.scorerVersion(store.loadConfig(h.p));
  assert.notEqual(newScorer, oldScorer);
  const brief = createSpinBrief({ paths: h.p });
  assert.equal(brief.versions().pendingThreads, 2, 'the Brief reports pending work without doing it');
  assert.equal(brief.versions().earlierArchivedThreads, 1);
  const gone = brief.findings({ since: 0, archive: true }).find(f => f.sessionId === GONE);
  assert.equal(gone.spin.scorer, oldScorer); assert.equal(gone.spin.earlierScorer, true); assert.equal(gone.spin.rescorePending, false);
  assert.equal(brief.findings({ since: 0, archive: true }).find(f => f.sessionId === LOOP).spin.rescorePending, true);

  const run = h.backfill();
  assert.equal(run.rescored, 2); assert.deepEqual(run.rescoreReasons, { 'earlier scorer version': 2 });
  assert.deepEqual(store.readJson(goneFile), goneBefore, 'the archive of a deleted transcript is untouched');
  assert.equal(store.readJson(store.episodePath(h.p, 'codex', LOOP)).episodes.filter(ep => !ep.superseded).every(ep => ep.scorer === newScorer), true);
  assert.equal(store.loadState(h.p, 'codex', CALM).scorer, newScorer);
  for (const [file, entry] of Object.entries(store.readManifest(h.p).files)) assert.equal(entry.scorer, fs.existsSync(file) ? newScorer : oldScorer, file);
  const v = createSpinBrief({ paths: h.p }).versions();
  assert.equal(v.pendingThreads, 0); assert.equal(v.earlierArchivedThreads, 1);
  const next = h.backfill();
  assert.equal(next.rescored, 0, 'rescored once, not on every run');
});

test('a display-only settings change does not rescore anything', t => {
  const h = homes(t);
  h.backfill();
  const before = h.snapshot();
  h.setConfig(c => ({ ...c, desktop: { ...c.desktop, enabled: false }, agentNudge: { mode: 'nudge', minLevel: 'watch' }, episodes: { retentionDays: 36500 } }));
  const run = h.backfill();
  assert.deepEqual([run.rescored, run.incremental, run.skipped], [0, 0, 3]);
  assert.equal(createSpinBrief({ paths: h.p }).versions().pendingThreads, 0);
  assert.deepEqual(h.snapshot(), before);
});

test('episodes a rescore no longer produces are kept and marked superseded, not deleted', t => {
  const h = homes(t);
  h.backfill();
  const file = store.episodePath(h.p, 'codex', LOOP);
  const original = store.readJson(file);
  // Raising both thresholds out of reach means the new scorer finds nothing.
  h.setConfig(c => ({ ...c, thresholds: { ...c.thresholds, watch: 0.999, alert: 1, reviewRoundWatch: 999, reviewRoundAlert: 1000, backToBackRepeat: 1000 } }));
  h.backfill();
  const after = store.readJson(file);
  assert.equal(after.episodes.length, original.episodes.length);
  assert.ok(after.episodes.every(ep => ep.superseded && ep.superseded.by === version.scorerVersion(store.loadConfig(h.p)) && ep.scorer === original.episodes[0].scorer));
  assert.equal(createSpinBrief({ paths: h.p }).findings({ since: 0, archive: true }).filter(f => f.sessionId === LOOP).length, 0, 'superseded episodes are not findings');
});

test('the manifest migrates in place from the pre-version format', t => {
  const h = homes(t);
  const legacy = {};
  for (const id of [LOOP, GONE, CALM]) { const st = fs.statSync(h.file(id)); legacy[h.file(id)] = { size: st.size, mtimeMs: st.mtimeMs }; }
  fs.mkdirSync(h.p.stateDir, { recursive: true });
  fs.writeFileSync(h.p.manifestFile, JSON.stringify(legacy));
  const migrated = store.migrateManifest(legacy);
  assert.equal(migrated.v, 2); assert.equal(migrated.migratedFrom, 1);
  assert.deepEqual(migrated.files[h.file(LOOP)], { ...legacy[h.file(LOOP)], scorer: version.UNVERSIONED });
  assert.equal(store.migrateManifest(migrated), migrated, 'v2 is left alone');
  assert.deepEqual(store.migrateManifest(null).files, {});
  const brief = createSpinBrief({ paths: h.p });
  assert.equal(brief.versions().pendingThreads, 3, 'legacy entries count as scored by an earlier version');
  const run = h.backfill();
  assert.deepEqual(run.rescoreReasons, { 'earlier scorer version': 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.p.manifestFile.replace(/\.json$/, '.v1.json'), 'utf8')), legacy, 'the old manifest is kept as a backup');
  const manifest = store.readJson(h.p.manifestFile);
  assert.equal(manifest.v, 2);
  assert.equal(Object.keys(manifest.files).length, 3);
  assert.equal(h.backfill().rescored, 0);
});

test('the hook stamps new state with the current version and leaves an earlier stamp for the backfill', t => {
  const h = homes(t);
  const run = input => spawnSync(process.execPath, [HOOK, '--source', 'codex'], { input: JSON.stringify(input), env: h.env, encoding: 'utf8' });
  run({ session_id: CALM, turn_id: 't', transcript_path: h.file(CALM) });
  const scorer = version.scorerVersion(store.loadConfig(h.p));
  assert.equal(store.loadState(h.p, 'codex', CALM).scorer, scorer);
  h.setConfig(c => ({ ...c, thresholds: { ...c.thresholds, alert: 0.9 } }));
  fs.appendFileSync(h.file(CALM), codex.cmd(99999, 'node more.js') + '\n');
  run({ session_id: CALM, turn_id: 't', transcript_path: h.file(CALM) });
  const state = store.loadState(h.p, 'codex', CALM);
  assert.equal(state.offset, fs.statSync(h.file(CALM)).size, 'still resumes incrementally');
  assert.equal(state.scorer, scorer, 'keeps the earlier stamp until a rescore');
});

test('the rescore endpoint reports pending work and progress from the backfill progress file', t => {
  const h = homes(t);
  fs.mkdirSync(h.p.stateDir, { recursive: true });
  store.atomicWrite(h.p.progressFile, { pid: process.pid, phase: 'rescore', startedAt: Date.now(), updatedAt: Date.now(), done: 3, total: 12, bytesDone: 10, bytesTotal: 40 });
  const brief = createSpinBrief({ paths: h.p });
  const status = brief.rescoreStatus();
  assert.equal(status.running, true); assert.equal(status.done, 3);
  store.atomicWrite(h.p.progressFile, { pid: process.pid, done: 12, total: 12, finishedAt: Date.now(), updatedAt: Date.now() });
  assert.equal(brief.rescoreStatus().running, false);
  assert.equal(strip({ outcome: 1, a: 1 }).a, 1);
});
