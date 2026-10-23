'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const spin = require('../lib/spin');
const reference = require('../lib/spin-reference.json');
const { codex, claude, healthyCodex, treadmillCodex } = require('./spin-helpers');

const run = (lines, source = 'codex', cfg = {}) => {
  const state = spin.newState({ source, id: 'thread-1', file: '/tmp/x.jsonl' });
  const c = spin.config(cfg);
  for (const line of lines) spin.ingestLine(state, line, c);
  return { state, out: spin.takeOutbox(state), assessment: spin.assess(state, c), reasons: spin.reasons(state, c) };
};

test('reference distributions keep the calibration scale and rank values by mid-rank', () => {
  assert.equal(reference.rolledSpans, 3745);
  assert.equal(reference.rootThreads, 253);
  const zero = spin.percentile('max_round', 0);
  assert.ok(zero > 0.2 && zero < 0.6, 'many reference spans mention no round, so 0 sits mid-low');
  assert.ok(spin.percentile('max_round', 44) > 0.8);
  assert.equal(spin.percentile('skel_rep', -1), 0);
  assert.equal(spin.percentile('skel_rep', 5), 1);
  assert.deepEqual(spin.FEATURES.map(([feature]) => feature), ['ceremony_share', 'new_files', 'max_round', 'skel_rep', 'waits_per_action']);
});

test('command skeletons strip prefixes, rtk, paths and numbers', () => {
  assert.equal(spin.skeleton('cd /home/dev/Repos/app && rtk pnpm run pre-merge --pr 1234'), 'pnpm run pre-merge --pr N');
  assert.equal(spin.skeleton('cat /home/dev/Repos/app/.worktrees/team/fix-1/a.txt'), 'cat <WT>/a.txt');
  assert.equal(spin.skeleton('FOO=1 git log 3f2a9c1d'), 'git log H');
  assert.equal(spin.isPoll(spin.skeleton('sleep 30 && gh pr checks 12')), true);
  assert.equal(spin.isPoll(spin.skeleton('pnpm run pre-merge')), false);
});

test('calm: steady building with new files stays calm', () => {
  const { state, assessment } = run(healthyCodex('calm'));
  assert.equal(state.n, 160);
  assert.equal(state.readings.length, 4);
  assert.equal(assessment.level, 'calm');
  assert.ok(assessment.score < 0.6, `score ${assessment.score}`);
  assert.equal(state.ep, null);
});

test('merge-gate treadmill made of succeeding commands reaches at least watch with plain reasons', () => {
  const { state, assessment, reasons, out } = run(treadmillCodex('loop'));
  assert.ok(spin.rank(assessment.level) >= 1, `level ${assessment.level} score ${assessment.score}`);
  assert.ok(assessment.score >= 0.7);
  assert.ok(state.ep && state.ep.trail.length === spin.TRAIL);
  assert.ok(reasons.some(text => /heavy gate runs|process ceremony/.test(text)), reasons.join(' | '));
  assert.ok(reasons.some(text => /new files? in the last/.test(text)), reasons.join(' | '));
  assert.ok(out.changes.some(change => change.from === 'calm'));
  assert.ok(state.ep.trail.every(row => !row.cmd || row.cmd.length <= 120));
});

test('review round 40+ is an alert; round 20+ is a watch', () => {
  const base = healthyCodex('rounds', 20);
  const alert = run([...base, codex.say(900, 'Starting review round 42 now.'), codex.cmd(901, 'pnpm test')]);
  assert.equal(alert.assessment.level, 'alert');
  assert.ok(alert.reasons.includes('review round 42'), alert.reasons.join(' | '));
  const watch = run([...base, codex.say(900, 'Review pass 23 found another issue.'), codex.cmd(901, 'pnpm test')]);
  assert.equal(watch.assessment.level, 'watch');
  const pr = run([...base, codex.cmd(899, 'echo'), JSON.stringify({ timestamp: '2026-03-02T12:30:00Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 's1', arguments: JSON.stringify({ task_name: 'review_pr_3456' }) } })]);
  assert.equal(pr.state.maxRound, 345, 'the round feature reads digits from review-like helper names');
  assert.equal(pr.assessment.level, 'calm', 'but the plain-English rule ignores a PR number');
});

test('the same command 5+ times back-to-back is an alert; repeated polling is reported as waiting', () => {
  const lines = [...healthyCodex('repeat', 10)];
  for (let i = 0; i < 7; i++) lines.push(codex.cmd(500 + i, 'node scripts/sync-labels.mjs --pr 77'));
  const repeat = run(lines);
  assert.equal(repeat.assessment.level, 'alert');
  assert.ok(repeat.reasons.includes('same command 7 times in a row'), repeat.reasons.join(' | '));
  const polls = [...healthyCodex('poll', 10)];
  for (let i = 0; i < 8; i++) polls.push(codex.cmd(500 + i, 'sleep 60 && gh pr checks 77'));
  const waiting = run(polls);
  assert.equal(waiting.assessment.level, 'calm');
  assert.ok(waiting.reasons.some(text => /waiting: the same check 8 times/.test(text)));
});

test('Claude Code is capped at watch by default and says so', () => {
  const lines = [claude.user(0, 'Fix the release gate')];
  for (let i = 0; i < 6; i++) { lines.push(claude.bash(10 + i * 2, `tool${i}`, 'pnpm verify-release --pr 12')); lines.push(claude.result(11 + i * 2, `tool${i}`, 'refused')); }
  const capped = run(lines, 'claude');
  assert.equal(capped.assessment.uncapped, 'alert');
  assert.equal(capped.assessment.level, 'watch');
  assert.ok(capped.reasons.some(text => /capped at watch for Claude Code/.test(text)));
  assert.equal(run(lines, 'claude', { claudeMaxLevel: 'alert' }).assessment.level, 'alert');
  assert.equal(capped.state.firstRequest, 'Fix the release gate');
});

test('callout detection finds churn complaints and skips instructions, PR churn and UI spinners', () => {
  for (const text of ["it looks like you're churning, what is going on?", 'are you spinning your wheels?', 'I think you\'re spinning', 'churning?',
    'why does this keep repeating over and over?', 'we are going in circles here', 'ok, stop this churn and wrap up']) assert.equal(spin.isCallout(text), true, text);
  for (const text of ['go ahead in small steps and keep the PR churn low', 'Draft the plan first. Monitor churn and keep it tight.',
    'Do not churn. Start by reading the branch', 'keep churn to a minimum please', 'avoid churn in the docs', 'the loading spinner never stops',
    'spin up a fresh worktree', "the parser has a known bug, so don't spin your wheels there", 'this is mostly line-ending churn',
    'user: are you churning?\nassistant: no\nuser: ok', 'could we automatically flag threads where I call out churn',
    'so it cannot detect churning agents on its own?', 'The button keeps spinning after the save failed; the status icon should turn green',
    'add a way to flag agent threads that loop forever, are churning, or repeat', 'Can this also keep churn evidence for older threads?', '<environment_context>churning</environment_context>']) assert.equal(spin.isCallout(text), false, text);
});

test('callouts attach to an open episode, or are recorded as misses when nothing fired', () => {
  const quiet = run([...healthyCodex('miss', 20), codex.user(900, "you're churning")]);
  assert.equal(quiet.out.misses.length, 1);
  assert.equal(quiet.out.callouts.length, 1);
  const loud = run([...treadmillCodex('hit'), codex.user(7300, 'are you spinning your wheels?')]);
  assert.equal(loud.out.misses.length, 0);
  assert.equal(loud.state.ep.callouts.length, 1);
  assert.equal(spin.outcomeOf(loud.state.ep), 'user called it out');
  const late = run([...treadmillCodex('late'), codex.user(7200 + 30 * 3600, "you're churning")]);
  assert.equal(late.out.misses.length, 1, 'a callout long after the episode went quiet is a miss');
});

test('nudge text follows the agreed wording', () => {
  assert.equal(spin.nudgeText(['review round 42', 'same command 7 times in a row']),
    'Spin check: review round 42; same command 7 times in a row. Pause and post to the user: the original goal, what is concretely left, and whether another round/gate is worth it. Continue only if you can justify it.');
});

test('configured pattern lists replace the project-neutral defaults', () => {
  const lines = [...healthyCodex('custom', 10), codex.cmd(900, 'ship-it --now'), codex.say(901, 'next'), JSON.stringify({ timestamp: '2026-03-02T12:30:00Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 's2', arguments: JSON.stringify({ task_name: 'inspector_r7' }) } })];
  const plain = run(lines);
  assert.equal(plain.state.merges, 0);
  assert.equal(plain.state.maxRound, 0);
  const custom = run(lines, 'codex', { mergePatterns: ['\\bship-it\\b'], reviewHelperPatterns: ['inspector'] });
  assert.equal(custom.state.merges, 1);
  assert.equal(custom.state.maxRound, 7);
  const c = spin.config({ gatePatterns: ['bake'], ceremonyPatterns: ['bake'] });
  assert.ok(c._compiled.gate.test(spin.skeleton('npm run bake --all')) && !c._compiled.gate.test('git status'));
  assert.ok(c._compiled.ceremony.test('npm run bake') && !c._compiled.ceremony.test('git fetch'));
});
