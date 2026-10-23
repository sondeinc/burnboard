#!/usr/bin/env node
'use strict';

// Calibration replay for spin watch (not part of npm test). Replays your own
// hand-labeled threads as if the hook had fired after every action and reports
// how early each level fired relative to your callouts. Labels come from
// --labels <file>, BURNBOARD_SPIN_SEED_LABELS, or seed-labels.json in the spin
// state directory: { "labels": [{ "id", "source", "group": "flagged"|"control",
// "label", "callouts": [epoch ms, ...] }] }. With --study <dir> (or
// BURNBOARD_SPIN_STUDY) holding an offline analysis's scores.json and
// windows.json, its scores are compared too.
//
//   node scripts/spin-calibrate.js [--labels <file>] [--study <dir>] [--json]
const fs = require('node:fs');
const path = require('node:path');
const spin = require('../lib/spin');
const store = require('../lib/spin-store');
const { replayFile, listTranscripts } = require('../lib/spin-replay');

const argv = process.argv.slice(2);
const arg = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const studyDir = arg('--study') || process.env.BURNBOARD_SPIN_STUDY || null;
const labelsFile = arg('--labels');
const CHURN = new Set(['CHURN-LOOP', 'CHURN-DRIFT', 'REVIEW-CYCLE']);
const H = 3600000;
const R = spin.rank;

function levelAt(changes, t) {
  let level = 'calm';
  for (const change of changes) { if (change.t > t) break; level = change.to; }
  return level;
}
function hotWithin(changes, from, to, min) {
  if (R(levelAt(changes, from)) >= R(min)) return true;
  return changes.some(change => change.t > from && change.t <= to && R(change.to) >= R(min));
}
function firstAt(changes, min) { const hit = changes.find(change => R(change.to) >= R(min)); return hit ? hit.t : null; }

function studyView(study, label, threshold) {
  // study scores are per 40-action window; sustained = mean of the last 3
  const o = study.scores.get(label.id); const ws = study.windows.get(label.id) || [];
  if (!o) return null;
  const sus = o.scores.map((_, i) => { const s = o.scores.slice(Math.max(0, i - 2), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
  const changes = []; let cur = 'calm';
  sus.forEach((v, i) => { if (i < 2) return; const lvl = v >= threshold.alert ? 'alert' : v >= threshold.watch ? 'watch' : 'calm'; if (lvl !== cur && ws[i]) { changes.push({ t: ws[i].t1, to: lvl }); cur = lvl; } });
  return { changes, peak: o.peak };
}
function loadStudy() {
  if (!studyDir) return null;
  try {
    const scores = new Map(JSON.parse(fs.readFileSync(path.join(studyDir, 'scores.json'), 'utf8')).map(o => [o.id, o]));
    const windows = new Map();
    for (const w of JSON.parse(fs.readFileSync(path.join(studyDir, 'windows.json'), 'utf8'))) {
      if (!windows.has(w.thread)) windows.set(w.thread, []);
      windows.get(w.thread).push(w);
    }
    return { scores, windows };
  } catch (_) { return null; }
}

function summarize(rows, key) {
  const flagged = rows.filter(r => r.group === 'flagged');
  const controls = rows.filter(r => r.group === 'control');
  const before = (min) => flagged.filter(r => r[key] && r[key].first[min] != null && r[key].first[min] <= r.callouts[0]).length;
  let callouts = 0, preceded = 0;
  for (const r of rows.filter(x => x.group === 'flagged')) for (const t of r.callouts) { callouts++; if (r[key] && hotWithin(r[key].changes, t - 12 * H, t, 'watch')) preceded++; }
  const fired = (list, min) => list.filter(r => r[key] && r[key].first[min] != null);
  const labeledHot = rows.filter(r => r[key] && r[key].first.watch != null);
  const labeledAlert = rows.filter(r => r[key] && r[key].first.alert != null);
  return {
    flaggedBeforeCallout: { watch: before('watch'), alert: before('alert'), of: flagged.length },
    calloutsPrecededWithin12h: { hits: preceded, of: callouts },
    controlsFired: { watch: fired(controls, 'watch').map(r => r.short), alert: fired(controls, 'alert').map(r => r.short), of: controls.length },
    precision: { watch: `${labeledHot.filter(r => CHURN.has(r.label)).length}/${labeledHot.length}`, alert: `${labeledAlert.filter(r => CHURN.has(r.label)).length}/${labeledAlert.length}` },
  };
}

function main() {
  const p = store.paths();
  const cfg = spin.config(store.loadConfig(p, { create: false }));
  const scoreOnly = spin.config({ ...cfg, thresholds: { ...cfg.thresholds, reviewRoundWatch: 1e9, reviewRoundAlert: 1e9, backToBackRepeat: 1e9 }, claudeMaxLevel: 'alert' });
  const files = new Map(listTranscripts(p).map(item => [item.file, item]));
  const find = id => [...files.values()].find(item => path.basename(item.file).includes(id) && !item.file.includes('/subagents/'));
  const study = loadStudy();
  const seeds = store.loadSeedLabels(labelsFile ? { ...p, seedLabelsFile: path.resolve(labelsFile) } : p);
  if (!seeds.length) { console.error(`No hand labels found in ${labelsFile || p.seedLabelsFile}; pass --labels <file>.`); process.exitCode = 1; return; }
  const rows = [];
  for (const label of seeds) {
    const item = find(label.id);
    const row = { short: label.id.slice(0, 13), id: label.id, group: label.group, label: label.label, source: label.source, callouts: (label.callouts || []).slice().sort((a, b) => a - b) };
    if (!item) { row.missing = true; rows.push(row); continue; }
    for (const [key, c] of [['port', cfg], ['portScoreOnly', scoreOnly]]) {
      const result = replayFile(item.file, label.source, c, { keepChanges: true, now: Date.now() });
      const changes = result.changes.map(x => ({ t: x.t, to: x.to, reasons: x.reasons }));
      row[key] = { changes, first: { watch: firstAt(changes, 'watch'), alert: firstAt(changes, 'alert') },
        peak: Math.max(0, ...result.episodes.map(ep => ep.peakScore)), episodes: result.episodes.length,
        reasons: (result.episodes.find(ep => R(ep.peakLevel) >= 1) || {}).reasons || [] };
    }
    if (study) {
      const v = studyView(study, label, cfg.thresholds);
      if (v) row.study = { changes: v.changes, first: { watch: firstAt(v.changes, 'watch'), alert: firstAt(v.changes, 'alert') }, peak: v.peak };
    }
    rows.push(row);
  }
  const report = { thresholds: cfg.thresholds, claudeMaxLevel: cfg.claudeMaxLevel, port: summarize(rows, 'port'), portScoreOnly: summarize(rows, 'portScoreOnly'), study: study ? summarize(rows, 'study') : null };
  if (argv.includes('--json')) { console.log(JSON.stringify({ report, rows }, null, 1)); return; }
  const fmtLead = (r, key) => {
    if (!r[key]) return '   -  ';
    const f = r[key].first.watch; const c = r.callouts[0];
    if (f == null) return ' none ';
    if (!c) return ' fired';
    return f <= c ? `${((c - f) / H).toFixed(1).padStart(5)}h` : ' late ';
  };
  console.log('Spin watch calibration replay (hook fired after every action)\n');
  console.log('thread         group      label         port: first watch lead / max level   score-only lead   study lead');
  for (const r of rows) {
    if (r.missing) { console.log(`${r.short}  ${r.group.padEnd(9)}  ${String(r.label).padEnd(12)}  transcript not found`); continue; }
    const max = r.port.first.alert != null ? 'alert' : r.port.first.watch != null ? 'watch' : 'calm';
    console.log(`${r.short}  ${r.group.padEnd(9)}  ${r.label.padEnd(12)}  ${fmtLead(r, 'port')} ${max.padEnd(5)}  ${(r.port.reasons[0] || '').slice(0, 34).padEnd(34)}  ${fmtLead(r, 'portScoreOnly')}   ${fmtLead(r, 'study')}`);
  }
  const line = (name, s) => s && console.log(`\n${name}:\n  flagged threads at watch+ before the first callout: ${s.flaggedBeforeCallout.watch}/${s.flaggedBeforeCallout.of} (alert before callout: ${s.flaggedBeforeCallout.alert})\n  callouts preceded by watch+ within 12 h: ${s.calloutsPrecededWithin12h.hits}/${s.calloutsPrecededWithin12h.of}\n  controls that reached watch: ${s.controlsFired.watch.length}/${s.controlsFired.of} [${s.controlsFired.watch.join(', ')}]; alert: ${s.controlsFired.alert.length} [${s.controlsFired.alert.join(', ')}]\n  labeled threads that fired, share that were churn: watch ${s.precision.watch}, alert ${s.precision.alert}`);
  line('Port (score + extra rules + Claude cap)', report.port);
  line('Port, score only (no extra rules, no cap)', report.portScoreOnly);
  line('Study (scores.json, same thresholds)', report.study);
}

main();
