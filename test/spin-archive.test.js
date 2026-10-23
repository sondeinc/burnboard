'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const spin = require('../lib/spin');
const store = require('../lib/spin-store');
const { replayFile } = require('../lib/spin-replay');
const { codex, healthyCodex, treadmillCodex } = require('./spin-helpers');

const BACKFILL = path.resolve(__dirname, '..', 'scripts', 'spin-backfill.js');
const LOOP = '0f0f0001-aaaa-7bbb-8ccc-000000000001'; // carries a synthetic seed label
const QUIET = '0f0f0002-aaaa-7bbb-8ccc-000000000002';
// Synthetic hand labels: one matches LOOP, two belong to transcripts that are gone.
const SEEDS = { version: 1, labels: [
  { id: LOOP, source: 'codex', group: 'flagged', label: 'REVIEW-CYCLE', note: 'Review rounds kept finding one more nit.', callouts: [1] },
  { id: '0f0f0003-aaaa-7bbb-8ccc-000000000003', source: 'codex', group: 'control', label: 'PRODUCTIVE', note: 'Shipped the feature.', callouts: [] },
  { id: '0f0f0004-aaaa-7bbb-8ccc-000000000004', source: 'claude', group: 'flagged', label: 'CHURN-LOOP', note: 'Re-ran the same check.', callouts: [2] },
] };

function homes(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const day = path.join(dir, '.codex', 'sessions', '2026', '03', '02');
  fs.mkdirSync(day, { recursive: true }); fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
  const loop = path.join(day, `rollout-2026-03-02T12-00-00-${LOOP}.jsonl`);
  const quiet = path.join(day, `rollout-2026-03-02T12-00-00-${QUIET}.jsonl`);
  fs.writeFileSync(loop, [codex.meta(LOOP), codex.user(1, 'Finish review round 13, then merge'), ...treadmillCodex(LOOP, 240).slice(1), codex.user(7300, "you're churning, stop")].join('\n') + '\n');
  fs.writeFileSync(quiet, [...healthyCodex(QUIET, 80), codex.user(2000, 'are you spinning your wheels?')].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, '.codex', 'session_index.jsonl'), JSON.stringify({ id: LOOP, thread_name: 'Finish PR #123' }) + '\n');
  const p = store.paths({ stateDir: path.join(dir, 'state'), codexHome: path.join(dir, '.codex'), claudeHome: path.join(dir, '.claude') });
  store.atomicWrite(p.seedLabelsFile, JSON.stringify(SEEDS));
  const backfill = (...extra) => spawnSync(process.execPath, [BACKFILL, '--state', p.stateDir, '--codex-home', p.codexHome, '--claude-home', p.claudeHome, '--workers', '2', '--quiet', '--json', ...extra],
    { encoding: 'utf8', env: { ...process.env, HOME: dir, BURNBOARD_SPIN_CONFIG: path.join(dir, 'spin.json') } });
  return { dir, p, loop, quiet, backfill };
}
const strip = value => JSON.parse(JSON.stringify(value, (key, v) => ['updatedAt', 'backfilledAt'].includes(key) ? undefined : v));

test('an episode keeps compact, durable evidence: ids, times, score history, trail, humans, outcome', t => {
  const h = homes(t);
  const result = replayFile(h.loop, 'codex', {}, { now: Date.parse('2026-03-06T00:00:00Z') });
  assert.equal(result.episodes.length, 1);
  store.writeReplay(h.p, result.state, result.episodes, result.callouts, result.misses);
  const archived = store.readJson(store.episodePath(h.p, 'codex', LOOP));
  assert.equal(archived.threadId, LOOP); assert.equal(archived.source, 'codex'); assert.equal(archived.repo, 'app');
  assert.equal(archived.firstRequest, 'Finish review round 13, then merge');
  const ep = archived.episodes[0];
  for (const key of ['id', 'start', 'peakT', 'end', 'peakScore', 'peakLevel', 'reasons', 'history', 'trail', 'humans', 'callouts', 'outcome']) assert.ok(key in ep, key);
  assert.ok(ep.end > ep.start, 'a long-idle episode is closed');
  assert.equal(ep.outcome, 'user called it out');
  assert.ok(ep.trail.length <= 120 && ep.trail.every(row => row.t && row.op && (!row.cmd || row.cmd.length <= 120)));
  assert.ok(ep.history.length >= 2);
  assert.ok(ep.humans.some(item => /churning/.test(item.text)));
  assert.ok(ep.reasons.length >= 2);
  assert.ok(JSON.stringify(archived).length < 60000, 'no full outputs are archived');
});

test('backfill is idempotent, seeds local hand labels, records misses, and leaves archives of deleted transcripts alone', t => {
  const h = homes(t);
  let run = h.backfill();
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(summary.rescored, 2); assert.equal(summary.labelsSeeded, 3);
  const loopFile = store.episodePath(h.p, 'codex', LOOP), quietFile = store.episodePath(h.p, 'codex', QUIET);
  const first = store.readJson(loopFile);
  assert.equal(first.title, 'Finish PR #123');
  assert.equal(first.label.label, 'REVIEW-CYCLE');
  assert.match(first.label.note, /one more nit/);
  assert.equal(first.episodes.length, 1);
  const quiet = store.readJson(quietFile);
  assert.equal(quiet.episodes.length, 0);
  assert.equal(quiet.misses.length, 1, 'a callout with no episode is a miss');
  assert.equal(fs.readdirSync(h.p.episodesDir).length, 4);

  run = h.backfill();
  const again = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(again.rescored + again.incremental, 0, 'unchanged transcripts are skipped');
  assert.equal(again.skipped, 2); assert.equal(again.labelsSeeded, 0, 'labels already seeded are not rewritten');
  run = h.backfill('--force');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(strip(store.readJson(loopFile)), strip(first), 'rescoring produces the same archive');

  fs.rmSync(h.loop);
  run = h.backfill('--force');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(strip(store.readJson(loopFile)).episodes, strip(first).episodes, 'deleted transcript: archived evidence survives');
});

test('retention prunes old episodes only when configured', t => {
  const h = homes(t);
  h.backfill();
  const file = store.episodePath(h.p, 'codex', LOOP);
  const before = store.readJson(file).episodes.length;
  assert.equal(store.prune(h.p, null), 0, 'null keeps forever');
  assert.equal(store.prune(h.p, 30, Date.parse('2026-03-06T00:00:00Z')), 0);
  assert.equal(store.prune(h.p, 30, Date.parse('2027-06-01T00:00:00Z')), before);
  assert.ok(fs.existsSync(file), 'seed labels keep their file');
  assert.equal(store.readJson(file).episodes.length, 0);
});

test('config is created with documented defaults and validated on save', t => {
  const h = homes(t);
  const p = { ...h.p, configFile: path.join(h.dir, 'cfg', 'spin.json') };
  const config = store.loadConfig(p);
  assert.ok(fs.existsSync(p.configFile));
  assert.deepEqual(config.desktop, { enabled: true, minLevel: 'alert', cooldownMinutes: 60 });
  assert.deepEqual(config.agentNudge, { mode: 'shadow', minLevel: 'alert' });
  assert.deepEqual(config.thresholds, { watch: 0.7, alert: 0.85, reviewRoundWatch: 20, reviewRoundAlert: 40, backToBackRepeat: 5 });
  assert.equal(config.claudeMaxLevel, 'watch');
  assert.deepEqual(config.sources, { codex: true, claude: true });
  assert.equal(config.episodes.retentionDays, null);
  assert.deepEqual(config.ceremonyPatterns, spin.DEFAULT_CEREMONY_PATTERNS);
  assert.deepEqual(config.gatePatterns, spin.DEFAULT_GATE_PATTERNS);
  assert.deepEqual(config.mergePatterns, spin.DEFAULT_MERGE_PATTERNS);
  assert.deepEqual(config.reviewHelperPatterns, spin.DEFAULT_REVIEW_HELPER_PATTERNS);
  assert.deepEqual(store.saveConfig(p, { ...config, gatePatterns: ['(unclosed'] }).errors, ['gatePatterns entry is not a valid regular expression: (unclosed']);
  assert.deepEqual(store.saveConfig(p, { ...config, agentNudge: { mode: 'loud' } }).errors, ['agentNudge.mode must be off, shadow or nudge']);
  assert.ok(store.saveConfig(p, { ...config, thresholds: { ...config.thresholds, watch: 0.9 } }).errors.length);
  const saved = store.saveConfig(p, { ...config, desktop: { ...config.desktop, enabled: false }, agentNudge: { mode: 'nudge', minLevel: 'watch' } });
  assert.equal(saved.config.desktop.enabled, false);
  assert.equal(store.loadConfig(p).agentNudge.mode, 'nudge');
});
