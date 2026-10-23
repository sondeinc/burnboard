#!/usr/bin/env node
'use strict';

// Rebuilds lib/spin-reference.json from an offline analysis of your own
// transcripts. The analysis directory holds windows.json (per-thread 40-action
// windows with the five signal values) and threads.json ({ id, root } per
// thread). Every rolled three-window (~120-action) span of the root sessions
// becomes the reference each live signal is ranked against, which keeps live
// spin scores on the same 0..1 scale as the calibration.
//
//   node scripts/spin-reference.js --study <dir>     (or BURNBOARD_SPIN_STUDY=<dir>)
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const studyDir = (args.includes('--study') ? args[args.indexOf('--study') + 1] : null) || process.env.BURNBOARD_SPIN_STUDY;
if (!studyDir) { console.error('usage: node scripts/spin-reference.js --study <dir>'); process.exit(1); }
const out = path.resolve(__dirname, '..', 'lib', 'spin-reference.json');
const FEATURES = { ceremony_share: 'mean', new_files: 'sum', max_round: 'last', skel_rep: 'mean', waits_per_action: 'mean' };
const SPAN = 3;

const windows = JSON.parse(fs.readFileSync(path.join(studyDir, 'windows.json'), 'utf8'));
const threads = JSON.parse(fs.readFileSync(path.join(studyDir, 'threads.json'), 'utf8'));
const roots = new Set(threads.filter(thread => thread.root).map(thread => thread.id));
const byThread = new Map();
for (const w of windows) {
  if (!byThread.has(w.thread)) byThread.set(w.thread, []);
  byThread.get(w.thread).push(w);
}
const values = Object.fromEntries(Object.keys(FEATURES).map(feature => [feature, []]));
let rolled = 0;
for (const [thread, list] of byThread) {
  if (!roots.has(thread)) continue;
  list.forEach((w, i) => {
    const seg = list.slice(Math.max(0, i - SPAN + 1), i + 1);
    rolled++;
    for (const [feature, how] of Object.entries(FEATURES)) {
      const xs = seg.map(x => x[feature] == null ? 0 : Number(x[feature]));
      values[feature].push(how === 'mean' ? xs.reduce((a, b) => a + b, 0) / xs.length
        : how === 'sum' ? xs.reduce((a, b) => a + b, 0) : Number(w[feature] || 0));
    }
  });
}
const features = {};
for (const [feature, xs] of Object.entries(values)) {
  const counts = new Map();
  for (const x of xs) { const key = Math.round(x * 1e6) / 1e6; counts.set(key, (counts.get(key) || 0) + 1); }
  const sorted = [...counts].sort((a, b) => a[0] - b[0]);
  features[feature] = { values: sorted.map(entry => entry[0]), counts: sorted.map(entry => entry[1]) };
}
const reference = {
  version: 1,
  description: 'Reference distributions for burnboard spin watch: every rolled 120-action span of the root sessions in the calibration set. A live signal is rank-normalized (mid-rank) against these values.',
  windowActions: 40, spanWindows: SPAN, sustainReadings: 3, rolledSpans: rolled, rootThreads: [...byThread.keys()].filter(t => roots.has(t)).length,
  features,
};
fs.writeFileSync(out, JSON.stringify(reference) + '\n');
console.log(`wrote ${out}: ${rolled} spans from ${reference.rootThreads} root threads`);
