'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const activity = require('../lib/ui/spin-activity');
const store = require('../lib/spin-store');
const spin = require('../lib/spin');
const version = require('../lib/spin-version');
const { createSpinBrief, toFinding } = require('../lib/spin-brief');
const ui = require('../lib/ui/flight-recorder');

const MIN = 60000, HOUR = 3600000;
const start = new Date(2026, 2, 2, 9, 0, 0).getTime(); // local 09:00
const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const openEp = (extra = {}) => ({ id: 'codex-x-1', start, lastHotT: start + 10 * MIN, end: null, endReason: null, peakLevel: 'watch', peakScore: 0.8,
  reasons: ['review round 21'], callouts: [], merged: null, ...extra });
const thread = (lastSeen, extra = {}) => ({ threadId: 'x', source: 'codex', file: null, isRoot: true, lastSeen, episodes: [], ...extra });

test('open episodes read active, then idle since HH:MM, then abandoned, measured from the last recorded activity', () => {
  const seen = start + 40 * MIN; // newer than the last hot reading
  const at = now => activity.describe(openEp(), { now, thread: thread(seen) });
  assert.equal(activity.lastActivity(openEp(), thread(seen), seen + MIN), seen, 'the thread\'s newest event, not the last hot reading');
  assert.deepEqual(at(seen), { state: 'active', label: 'active', open: true, lastActivity: seen });
  assert.equal(at(seen + 5 * MIN).label, 'active', '5 minutes is still active');
  assert.equal(at(seen + 5 * MIN + 1).state, 'idle');
  assert.equal(at(seen + 5 * MIN + 1).label, `idle since ${hhmm(seen)}`);
  assert.equal(at(seen + 12 * HOUR).label, `idle since ${hhmm(seen)}`, '12 hours is still idle');
  assert.equal(at(seen + 12 * HOUR + 1).label, 'abandoned');
  assert.equal(at(seen + 12 * HOUR + 1).open, false);
  // No thread header: the episode's own times stand in.
  assert.equal(activity.describe(openEp(), { now: start + 12 * MIN }).label, 'active');
  // A thread time in the future (clock skew) counts as now.
  assert.equal(activity.lastActivity(openEp(), thread(start + 99 * HOUR), start + HOUR), start + HOUR);
});

test('the idle label carries the date when the last activity was not today', () => {
  const seen = new Date(2026, 2, 2, 23, 50).getTime();
  assert.equal(activity.describe(openEp({ start: seen - HOUR, lastHotT: seen }), { now: seen + 20 * MIN, thread: thread(seen) }).label, 'idle since Mar 2 23:50');
  assert.equal(activity.sinceText(new Date(2025, 11, 31, 8, 5).getTime(), new Date(2026, 0, 1, 9).getTime()), 'Dec 31, 2025 08:05');
  assert.equal(activity.sinceText(new Date(2026, 0, 1, 8, 5).getTime(), new Date(2026, 0, 1, 9).getTime()), '08:05');
});

test('closed episodes keep their recorded outcomes', () => {
  const later = start + 100 * HOUR;
  const closed = extra => activity.describe(openEp({ end: start + HOUR, ...extra }), { now: later, thread: thread(start + 2 * HOUR) }).label;
  assert.equal(closed({ endReason: 'calm' }), 'converged');
  assert.equal(closed({ endReason: 'inactive' }), 'abandoned');
  assert.equal(closed({ endReason: 'calm', merged: start + HOUR }), 'merged');
  assert.equal(closed({ endReason: 'calm', merged: start + HOUR, callouts: [{ t: start }] }), 'user called it out');
  // Same words as the scorer's own outcome for closed episodes.
  for (const extra of [{ endReason: 'calm' }, { endReason: 'inactive' }, { merged: 1 }, { callouts: [{ t: 1 }] }]) {
    const ep = openEp({ end: start + HOUR, ...extra });
    assert.equal(activity.describe(ep, { now: later }).state, spin.outcomeOf(ep, { now: later }));
  }
  // An open episode the user called out keeps that word in front of its activity.
  const called = activity.describe(openEp({ callouts: [{ t: start }] }), { now: start + 20 * MIN, thread: thread(start + 12 * MIN) });
  assert.equal(called.label, `user called it out · idle since ${hhmm(start + 12 * MIN)}`);
  assert.equal(called.state, 'idle');
});

test('thresholds come from activity.activeMinutes / activity.abandonHours and never change the scorer version', () => {
  const base = store.validateConfig({}).config;
  assert.deepEqual(base.activity, { activeMinutes: 5, abandonHours: 12 });
  const custom = store.validateConfig({ activity: { activeMinutes: 10, abandonHours: 2 } });
  assert.deepEqual(custom.errors, []);
  assert.deepEqual(custom.config.activity, { activeMinutes: 10, abandonHours: 2 });
  assert.equal(version.scorerVersion(custom.config), version.scorerVersion(base));
  assert.equal(version.scorerVersion({ ...base, activity: { activeMinutes: 1, abandonHours: 1 } }), version.scorerVersion({}));
  assert.ok(store.validateConfig({ activity: { activeMinutes: 0 } }).errors.length);
  assert.ok(store.validateConfig({ activity: { activeMinutes: 120, abandonHours: 1 } }).errors.some(e => /abandonHours/.test(e)));
  const seen = start + 40 * MIN;
  const settings = custom.config.activity;
  assert.equal(activity.describe(openEp(), { now: seen + 9 * MIN, thread: thread(seen), settings }).label, 'active');
  assert.equal(activity.describe(openEp(), { now: seen + 3 * HOUR, thread: thread(seen), settings }).label, 'abandoned');
});

test('the Brief label changes over time without rewriting the archived episode', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = store.paths({ stateDir: path.join(dir, 'state'), configFile: path.join(dir, 'spin.json'), codexHome: path.join(dir, '.codex'), claudeHome: path.join(dir, '.claude') });
  const seen = start + 40 * MIN;
  const file = store.episodePath(p, 'codex', 'x');
  store.atomicWrite(file, { v: 1, ...thread(seen), episodes: [{ ...openEp(), outcome: 'still running' }], callouts: [], misses: [] });
  const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
  const brief = createSpinBrief({ paths: p });
  const label = now => brief.findings({ since: start, now })[0].spin;
  assert.equal(label(seen + MIN).outcome, 'active');
  assert.equal(label(seen + MIN).open, true);
  assert.deepEqual(label(seen + MIN).activity, { state: 'active', lastActivity: seen, activeMinutes: 5, abandonHours: 12 });
  assert.equal(label(seen + 30 * MIN).outcome, `idle since ${hhmm(seen)}`);
  assert.equal(label(seen + 13 * HOUR).outcome, 'abandoned');
  assert.equal(label(seen + 13 * HOUR).open, false);
  assert.equal(brief.summary({ now: seen + 30 * MIN }).items[0].outcome, `idle since ${hhmm(seen)}`, 'the summary API uses the same words');
  // Thresholds from spin.json apply without a restart.
  store.saveConfig(p, { ...store.validateConfig({}).config, activity: { activeMinutes: 60, abandonHours: 12 } });
  assert.equal(label(seen + 30 * MIN).outcome, 'active');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the archive is untouched');
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  // The browser re-derives the same label from the finding as time passes.
  const finding = toFinding(thread(seen), openEp(), { now: seen + MIN });
  assert.equal(finding.spin.outcome, 'active');
  assert.equal(ui.spinOutcome(finding, seen + 30 * MIN), `idle since ${hhmm(seen)}`);
  assert.equal(ui.spinOutcome(finding, seen + 13 * HOUR), 'abandoned');
  const closed = toFinding(thread(seen), openEp({ end: seen, endReason: 'calm' }), { now: seen + MIN });
  assert.equal(ui.spinOutcome(closed, seen + 13 * HOUR), 'converged');
  // The badge's summary signature changes when a thread changes state.
  const sig = now => ui.summarySignature(brief.summary({ now }));
  assert.notEqual(sig(seen + MIN), sig(seen + 13 * HOUR));
});

test('the hook keeps an open episode\'s last activity current, throttled, forward-only, without creating files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = store.paths({ stateDir: path.join(dir, 'state'), configFile: path.join(dir, 'spin.json'), codexHome: path.join(dir, '.codex'), claudeHome: path.join(dir, '.claude') });
  const quiet = () => ({ episodes: [], closed: [], updates: [], misses: [], callouts: [], changes: [] });
  const state = spin.newState({ source: 'codex', id: 'x', file: path.join(dir, 'x.jsonl') });
  state.ep = openEp(); state.lastT = start + 20 * MIN;
  assert.equal(store.recordThread(p, state, quiet(), { now: start + 20 * MIN }), null, 'no archive file yet: nothing is created');
  store.recordThread(p, state, { ...quiet(), episodes: [state.ep] }, { now: start + 20 * MIN });
  const file = store.episodePath(p, 'codex', 'x');
  assert.equal(store.readJson(file).lastSeen, start + 20 * MIN);
  assert.equal(store.readJson(file).episodes[0].outcome, 'active', 'the stored snapshot uses the new words');
  state.lastT = start + 20 * MIN + 10000;
  assert.equal(store.recordThread(p, state, quiet(), { now: state.lastT }), null, 'refreshes are throttled');
  state.lastT = start + 25 * MIN;
  assert.ok(store.recordThread(p, state, quiet(), { now: state.lastT }));
  assert.equal(store.readJson(file).lastSeen, start + 25 * MIN);
  assert.equal(store.readJson(file).episodes.length, 1);
  // Out-of-order timestamps never move lastSeen backwards.
  state.lastT = start + 21 * MIN;
  store.recordThread(p, state, { ...quiet(), episodes: [state.ep] }, { now: start + 26 * MIN });
  assert.equal(store.readJson(file).lastSeen, start + 25 * MIN);
  // No open episode: quiet hook calls write nothing.
  state.ep = null; state.lastT = start + 60 * MIN;
  assert.equal(store.recordThread(p, state, quiet(), { now: state.lastT }), null);
  assert.equal(store.readJson(file).lastSeen, start + 25 * MIN);
});
