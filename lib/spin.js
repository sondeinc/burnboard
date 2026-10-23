'use strict';

// Spin watch scorer. Transcripts are cut into 40-action windows, the last
// three windows (~120 actions) are rolled together, five signals are
// rank-normalized against the reference distributions in spin-reference.json,
// and the equal-weight mean is smoothed over the last three readings.
//
// Everything here is deterministic and works on compact, JSON-serializable
// per-thread state, so the hook can resume a transcript from a byte offset
// without re-reading it. Nothing here performs I/O beyond loading reference data.
const REFERENCE = require('./spin-reference.json');

const WINDOW = REFERENCE.windowActions || 40;
const SPAN = REFERENCE.spanWindows || 3;
const SUSTAIN = REFERENCE.sustainReadings || 3;
const RING = 200;
const TRAIL = 120;
const SKEL_LOOKBACK = 160;
const LEVELS = ['calm', 'watch', 'alert'];
const rank = level => Math.max(0, LEVELS.indexOf(level));
const FEATURES = [['ceremony_share', 1], ['new_files', -1], ['max_round', 1], ['skel_rep', 1], ['waits_per_action', 1]];

// Built-in, project-neutral pattern lists (regular-expression sources). Each is
// replaced by the matching list in ~/.config/burnboard/spin.json, so a project's
// own command names belong there, not here.
// - ceremonyPatterns: process ceremony (syncing main, CI polling, regeneration,
//   lint-fix loops, review-round and receipt/attestation bookkeeping).
// - gatePatterns: names of heavy gate scripts; a package/node/shell invocation
//   of one counts as a gate run.
// - mergePatterns: a successful command matching one counts as a merge.
// - reviewHelperPatterns: helper (subagent) names that count as review rounds.
const DEFAULT_CEREMONY_PATTERNS = [
  'git merge[^|;&]*origin/(main|master)', 'git rebase', 'git pull', 'git fetch', 'git ls-remote',
  'worktree (add|list|prune)', 'gh pr (view|checks)', 'gh run (view|watch|rerun)', 'gh workflow run',
  'regenerate', 'codegen', '\\bgenerate\\b', 'lint[^|;&]*--fix', 'format[^|;&]*--(check|write)',
  'review[ -]round', 'receipt', 'attest', 'changeset', 'snapshot[^|;&]*(-u|--update)',
];
const DEFAULT_GATE_PATTERNS = ['pre-?merge', 'pre-?push', 'ci:\\w+', 'check:all', 'verify\\w*', 'validate\\w*'];
const DEFAULT_MERGE_PATTERNS = ['\\bgh pr merge\\b', '\\bglab mr merge\\b'];
const DEFAULT_REVIEW_HELPER_PATTERNS = ['review', 'audit', 'critic', 'verif', 'adversar', 'quality', 'edge'];

const DEFAULT_CONFIG = {
  enabled: true,
  desktop: { enabled: true, minLevel: 'alert', cooldownMinutes: 60 },
  agentNudge: { mode: 'shadow', minLevel: 'alert' },
  thresholds: { watch: 0.70, alert: 0.85, reviewRoundWatch: 20, reviewRoundAlert: 40, backToBackRepeat: 5 },
  claudeMaxLevel: 'watch',
  ceremonyPatterns: DEFAULT_CEREMONY_PATTERNS,
  gatePatterns: DEFAULT_GATE_PATTERNS,
  mergePatterns: DEFAULT_MERGE_PATTERNS,
  reviewHelperPatterns: DEFAULT_REVIEW_HELPER_PATTERNS,
  sources: { codex: true, claude: true },
  episodes: { retentionDays: null },
  dashboardUrl: 'http://localhost:4317',
};

// ---------------------------------------------------------------------------
// reference distributions (mid-rank percentile)
// ---------------------------------------------------------------------------
const REF = {};
for (const [feature, table] of Object.entries(REFERENCE.features)) {
  const cum = []; let total = 0;
  for (const count of table.counts) { cum.push(total); total += count; }
  REF[feature] = { values: table.values, counts: table.counts, cum, total };
}
function percentile(feature, value) {
  const ref = REF[feature];
  const v = Math.round((Number(value) || 0) * 1e6) / 1e6;
  let lo = 0, hi = ref.values.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ref.values[mid] < v) lo = mid + 1; else hi = mid; }
  const below = lo < ref.values.length ? ref.cum[lo] : ref.total;
  const atOrBelow = lo < ref.values.length && ref.values[lo] === v ? below + ref.counts[lo] : below;
  return (below + atOrBelow) / (2 * ref.total);
}
function scoreOf(features) {
  let sum = 0;
  const terms = {};
  for (const [feature, sign] of FEATURES) {
    const p = percentile(feature, features[feature]);
    terms[feature] = sign > 0 ? p : 1 - p;
    sum += terms[feature];
  }
  return { score: sum / FEATURES.length, terms };
}

// ---------------------------------------------------------------------------
// command skeletons
// ---------------------------------------------------------------------------
function stripPrefixes(command) {
  let s = String(command || '').trim();
  for (let i = 0; i < 6; i++) {
    let next = s.replace(/^(cd\s+\S+|export\s+[A-Za-z_][A-Za-z0-9_]*=\S*|set -[a-z]+(\s+-?o?\s*pipefail)?)\s*(&&|;|\n)\s*/, '');
    next = next.replace(/^env\s+(-u\s+\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    next = next.replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}
function skeleton(command) {
  let s = stripPrefixes(command || '');
  s = s.replace(/(^|&&|\|\||;|\|)\s*rtk(\s+proxy)?\s+/g, '$1 ');
  s = s.replace(/\/home\/[^/\s'"]+\/Repos\/[^/\s'"]+\/\.worktrees\/[^/\s'"]+\/[^/\s'"]+/g, '<WT>');
  s = s.replace(/\/home\/[^/\s'"]+\/Repos\/[^/\s'"]+\/\.codex\/worktrees\/[^/\s'"]+/g, '<WT>');
  s = s.replace(/\.worktrees\/[^/\s'"]+\/[^/\s'"]+/g, '<WT>');
  s = s.replace(/\/home\/[^/\s'"]+\/(Repos|Code|Personal)\/[^/\s'"]+/g, '<R>');
  s = s.replace(/\/tmp\/[^\s'"]+/g, '<TMP>');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'U');
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, 'H');
  s = s.replace(/\d+/g, 'N');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 240);
}
const POLL_RE = /^(git (status|diff --stat|diff --name-only|diff --shortstat|log|fetch|rev-parse|branch|show --stat|ls-remote|worktree list)|gh (pr (view|checks|status|list)|run (view|list|watch)|api\b)|sleep\b|ps\b|pgrep|tail -f|wc -l|ls\b|pwd\b|date\b|(pnpm|node) .*\b(worktree status|status)\b)/;
function isPoll(sk) {
  const segs = sk.split(/&&|\|\||;/).map(x => x.trim()).filter(Boolean);
  if (!segs.length) return false;
  if (/\bsleep N\b|gh pr checks|gh run watch|gh run view/.test(sk)) return true;
  const main = segs.map(x => x.split('|')[0].trim()).filter(x => !/^(echo|printf|true|test|\[)/.test(x));
  return main.length > 0 && main.every(x => POLL_RE.test(x));
}
const ROUND_RE = /\b(?:round|pass|rnd)\s*#?\s*(\d{1,3})\b/gi;
// A heavy gate *run* is a package/node/shell invocation of a gatePatterns name
// (not a read, poll or log check that mentions one); see compilePatterns.
// Commands that only look (read, search, poll a log, re-run a search tool):
// repeating them back-to-back is waiting or reading, not a loop.
const LOOK_ONLY_RE = /^(?:\s*(?:rtk\s+)?(?:sed|cat|rg|grep|nl|head|tail|jq|less|wc|ls|find|awk|ps|pgrep|stat|du|df|git (?:diff|show|log|blame|grep|status))\b|\w+=\$\((?:find|ls|cat|rg|grep|tail|head|pgrep|ps)\b|tool:|js: |Read |Grep |Glob )/;
const READLIKE = /^\s*(rtk\s+)?(sed|cat|rg|grep|nl|head|tail|read|jq|less|wc|ls|find|awk|git (diff|show|log|blame|grep)|bat)\b/;
const INF_ERR = /^(error|fatal|err!|fail|✗|×|traceback|\[ERR)|\b(command not found|no such file|elifecycle|exit code [1-9]|exited with code [1-9]|cannot find module|permission denied|read-only file system|err_pnpm\w*)\b/i;
const OK_RE = /\b0 (errors|failed|failures)\b|no errors|\bpassed\b|\bok\b/i;
const alternation = list => list.map(p => `(?:${p})`).join('|');
const compileList = (patterns, fallback, wrap = x => x, flags = '') => {
  try { return new RegExp(wrap(alternation(patterns && patterns.length ? patterns : fallback)), flags); }
  catch (_) { return new RegExp(wrap(alternation(fallback)), flags); }
};
function compilePatterns(c) {
  return {
    ceremony: compileList(c.ceremonyPatterns, DEFAULT_CEREMONY_PATTERNS),
    gate: compileList(c.gatePatterns, DEFAULT_GATE_PATTERNS, x => `^(?:pnpm|npm|npx|node|tsx|bash|sh|yarn)\\b[^|;&]*\\b(?:${x})\\b`),
    merge: compileList(c.mergePatterns, DEFAULT_MERGE_PATTERNS),
    review: compileList(c.reviewHelperPatterns, DEFAULT_REVIEW_HELPER_PATTERNS, x => x, 'i'),
  };
}

function h32(s) { // FNV-1a, base36: compact keys for bounded state
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// human callouts ("you're churning", "spinning your wheels", ...)
// ---------------------------------------------------------------------------
const CALLOUT_RE = /\b(churn(?:ing|ed|s)?|spinning|spin(?:ning)? (?:your|its|our|the|their) wheels|going (?:a?round )?in circles|run(?:ning)? (?:a?round )?in circles|over and over)\b/i;
const CALLOUT_EXCLUDE = [
  /\bPR[- ]churn\b/i,
  /\b(?:avoid|avoiding|minimi[sz]e|minimal|minimum|reduce|reducing|less|limit|limiting|monitor|without|don'?t|do not|never|keep|keeping|no)\b[\w\s'-]{0,24}\b(?:churn|spin)/i,
  /\bchurn\b[\w\s'-]{0,12}\b(?:to a minimum|minimal|low|down|tight)\b/i,
  /\bspin(?:ning|s)? (?:up|down|off|out|back)\b|\bspin-up\b|\bspinner|\bloading\b[\w\s]{0,20}spin|\bspinning (?:wheel|icon|indicator|circle)\b/i,
  /\b(?:code|line[- ]ending|feature|file|diff|generated[- ]\w+|doc|test|config|dependency|schema)[- ]churn\b/i,
  // talking about churn detection itself, not calling out this agent
  /\b(?:detect\w*|flag\w*|call(?:s|ed|ing)? out|retain\w*|track\w*|measur\w*|deterministic|historical)\b[\w\s',-]{0,60}\bchurn/i,
  /\bchurn(?:ing)?\b[\w\s'-]{0,12}\b(?:evidence|detection|detector|signals?|scores?|study|watch|metrics?|agents|threads|features?)\b/i,
];
function isCallout(text) {
  const value = String(text || '');
  if (!value || value.length > 800 || /^\s*(?:<|# Files mentioned)/.test(value)) return false;
  if ((value.match(/(?:^|\n|\s)(?:user|assistant):/g) || []).length >= 2) return false; // quoted transcript
  const match = value.match(CALLOUT_RE);
  if (!match) return false;
  // "spinning" next to UI words is a loading indicator, not an agent
  if (/^spin/i.test(match[0]) && !/wheels/i.test(match[0]) && /\b(?:chip|button|icon|ui|page|screen|spinner|loading|indicator|progress bar|modal|dialog|results?)\b/i.test(value)) return false;
  const near = value.slice(Math.max(0, match.index - 70), match.index + match[0].length + 30);
  return !CALLOUT_EXCLUDE.some(rx => rx.test(near));
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
function newState({ source, id, file, root = null, parent = null } = {}) {
  return {
    v: 1, source, id: id || null, file: file || null, offset: 0, ino: null, size: 0, gapBytes: 0,
    isRoot: true, parent, root, agentPath: null, cwd: '', title: '', firstRequest: '', startT: null, lastT: null,
    firstCmdT: null, firstEditT: null, n: 0, ring: [], skelSeen: {}, files: [], filesFull: false,
    win: emptyWindow(), wins: [], maxRound: 0, readings: [], streak: { k: '', c: 0, poll: false, from: null },
    latch: null, pending: {}, toolIds: [], spawnIds: [], pend: {}, lastHuman: null, humans: [], callouts: [],
    level: 'calm', levelT: null, score: 0, ep: null, lastClosed: null, merges: 0, lastMergeT: null,
    notified: { desktop: 'calm', desktopAt: 0, nudge: 'calm' }, out: null,
  };
}
function emptyWindow() { return { n: 0, cmd: 0, cer: 0, rep: 0, waits: 0, nf: 0, rmax: 0, t0: null, t1: null }; }
function outbox(state) {
  if (!state.out) state.out = { changes: [], callouts: [], episodes: [], closed: [], misses: [], updates: [] };
  return state.out;
}
function takeOutbox(state) { const out = outbox(state); state.out = null; return out; }

function config(cfg) {
  if (cfg && cfg._compiled) return cfg;
  const merged = mergeConfig(DEFAULT_CONFIG, cfg || {});
  Object.defineProperty(merged, '_compiled', { value: compilePatterns(merged), enumerable: false });
  return merged;
}
function mergeConfig(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && base[key] && !Array.isArray(base[key])) out[key] = mergeConfig(base[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// actions -> windows -> readings
// ---------------------------------------------------------------------------
function pushRing(state, item) {
  state.ring.push(item);
  if (state.ring.length > RING) state.ring.splice(0, state.ring.length - RING);
}
function addAction(state, action, cfg) {
  const c = config(cfg);
  const i = state.n++;
  const t = action.t;
  const w = state.win;
  if (w.t0 == null) w.t0 = t;
  w.t1 = t; w.n++;
  const item = { t, o: action.op[0] };
  if (action.op === 'cmd') {
    const cmd = String(action.cmd || '').slice(0, 600);
    const sk = skeleton(cmd);
    w.cmd++;
    const key = h32(sk);
    if (Object.hasOwn(state.skelSeen, key) && i - state.skelSeen[key] <= SKEL_LOOKBACK) w.rep++;
    state.skelSeen[key] = i;
    if (Object.keys(state.skelSeen).length > SKEL_LOOKBACK * 3) {
      for (const [k, at] of Object.entries(state.skelSeen)) if (i - at > SKEL_LOOKBACK) delete state.skelSeen[k];
    }
    if (c._compiled.ceremony.test(sk)) { w.cer++; item.c = 1; }
    const poll = isPoll(sk) || LOOK_ONLY_RE.test(sk);
    if (!poll && c._compiled.gate.test(sk)) item.g = 1;
    item.k = sk.slice(0, 120);
    if (action.exit != null) item.x = action.exit;
    if (action.err) item.e = String(action.err).slice(0, 120);
    const exact = h32(cmd);
    if (state.streak.k === exact) state.streak.c++;
    else state.streak = { k: exact, c: 1, poll, from: t, sk: sk.slice(0, 80) };
    if (action.exit === 0 && c._compiled.merge.test(cmd)) noteMerge(state, t);
    if (action.id) { state.pend[action.id] = i; trimKeys(state.pend, 60); }
  } else {
    state.streak = { k: '', c: 0, poll: false, from: null };
    if (action.op === 'edit') {
      const file = String(action.file || '');
      item.f = file.slice(-160);
      const key = h32(file);
      if (!state.files.includes(key)) {
        w.nf++;
        state.files.push(key);
        if (state.files.length > 20000) { state.files.splice(0, 1000); state.filesFull = true; }
      }
    } else {
      item.k = String(action.name || '').slice(0, 120);
      const name = String(action.name || '');
      const m = name.match(/(\d{1,3})/);
      // The round feature reads any 1-3 digits in a review-like helper name
      // (faithful, even when that is part of a PR number). The plain-English
      // rule only trusts explicit "round N" / "rN" / "pass N" names.
      if (m && c._compiled.review.test(name)) noteRound(state, Number(m[1]), !/(?:^|[^a-z])(?:round|rnd|pass|r)[-_ #]?\d{1,3}(?!\d)/i.test(name));
    }
  }
  pushRing(state, item);
  if (w.n >= WINDOW) closeWindow(state, c);
  evaluate(state, c, t);
}
function trimKeys(map, max) {
  const keys = Object.keys(map);
  for (let j = 0; j < keys.length - max; j++) delete map[keys[j]];
}
function noteRound(state, value, featureOnly = false) {
  if (!Number.isFinite(value)) return;
  if (value > state.maxRound) state.maxRound = value;
  if (!featureOnly && value > state.win.rmax) state.win.rmax = value;
  if (!featureOnly && value > (state.ruleRound || 0)) state.ruleRound = value;
}
function addAgentText(state, text) {
  const head = String(text || '').slice(0, 400);
  for (const m of head.matchAll(ROUND_RE)) {
    const v = Number(m[1]);
    if (v >= 1 && v <= 400) noteRound(state, v);
  }
}
function addWait(state) { state.win.waits++; }
function noteMerge(state, t) {
  state.merges++; state.lastMergeT = t;
  if (state.ep) { if (!state.ep.merged) { state.ep.merged = t; touchEpisode(state, state.ep); } return; }
  const closed = state.lastClosed;
  if (closed && !closed.merged && t - (closed.end || 0) <= 6 * 3600000) { closed.merged = t; outbox(state).updates.push({ id: closed.id, merged: t }); }
}

function closeWindow(state, c) {
  const w = state.win;
  const closed = {
    n: w.n, t0: w.t0, t1: w.t1,
    cer: w.cer / Math.max(w.cmd, 1), rep: w.rep / Math.max(w.cmd, 1), wpa: w.waits / w.n,
    waits: w.waits, nf: w.nf, cmd: w.cmd, mr: state.maxRound, rmax: w.rmax,
  };
  state.wins.push(closed);
  if (state.wins.length > 5) state.wins.splice(0, state.wins.length - 5);
  state.win = emptyWindow();
  const features = rolled(state);
  const { score } = scoreOf(features);
  state.readings.push({ t: w.t1, s: Math.round(score * 1e4) / 1e4, n: state.n });
  if (state.readings.length > 12) state.readings.splice(0, state.readings.length - 12);
  if (state.trace) state.trace.push({ t: w.t1, s: score, f: features, n: state.n });
  const sustained = sustainedScore(state);
  if (state.ep) {
    state.ep.history.push([w.t1, Math.round(sustained * 1000) / 1000, state.level]);
    if (state.ep.history.length > 400) state.ep.history.splice(0, state.ep.history.length - 400);
    touchEpisode(state, state.ep);
  }
  state.windowClosed = true;
}
function rolled(state) {
  const seg = state.wins.slice(-SPAN);
  const mean = key => seg.reduce((a, x) => a + x[key], 0) / seg.length;
  return {
    ceremony_share: mean('cer'), skel_rep: mean('rep'), waits_per_action: mean('wpa'),
    new_files: seg.reduce((a, x) => a + x.nf, 0), max_round: seg.length ? seg[seg.length - 1].mr : 0,
    actions: seg.reduce((a, x) => a + x.n, 0), waits: seg.reduce((a, x) => a + x.waits, 0), commands: seg.reduce((a, x) => a + x.cmd, 0),
  };
}
function sustainedScore(state) {
  const r = state.readings.slice(-SUSTAIN);
  return r.length ? r.reduce((a, x) => a + x.s, 0) / r.length : 0;
}
function recentRound(state) {
  return Math.max(state.win.rmax || 0, ...state.wins.map(w => w.rmax || 0));
}

// ---------------------------------------------------------------------------
// levels, reasons, episodes
// ---------------------------------------------------------------------------
function assess(state, cfg) {
  const c = config(cfg), th = c.thresholds || {};
  const enough = state.readings.length >= SUSTAIN;
  const score = enough ? sustainedScore(state) : 0;
  let level = !enough ? 'calm' : score >= th.alert ? 'alert' : score >= th.watch ? 'watch' : 'calm';
  const rules = [];
  const round = recentRound(state);
  if (round >= th.reviewRoundAlert) { level = 'alert'; rules.push('round'); }
  else if (round >= th.reviewRoundWatch) { if (rank(level) < 1) level = 'watch'; rules.push('round'); }
  const streak = state.streak;
  if (streak.c >= th.backToBackRepeat && !streak.poll) {
    state.latch = { level: 'alert', until: state.n + 2 * WINDOW, reason: `same command ${streak.c} times in a row`, at: state.lastT };
  }
  if (state.latch && state.n <= state.latch.until) { level = state.latch.level; rules.push('repeat'); }
  else if (state.latch) state.latch = null;
  let capped = level;
  if (state.source === 'claude' && rank(level) > rank(c.claudeMaxLevel || 'watch')) capped = c.claudeMaxLevel || 'watch';
  return { level: capped, uncapped: level, score, rules, round };
}
function reasons(state, cfg, assessment = assess(state, cfg)) {
  const out = [];
  const f = state.wins.length ? rolled(state) : null;
  if (assessment.rules.includes('repeat') && state.latch) out.push({ w: 2, text: state.latch.reason });
  const round = Math.max(assessment.round, state.ruleRound || 0);
  const terms = f ? scoreOf(f).terms : {};
  if (assessment.rules.includes('round') || (round >= 5 && terms.max_round >= 0.7)) out.push({ w: assessment.rules.includes('round') ? 1.5 : terms.max_round, text: `review round ${assessment.round || round}` });
  if (f) {
    const recent = state.ring.slice(-TRAIL);
    const gates = recent.filter(item => item.g);
    const hours = gates.length ? Math.max(0.1, ((state.lastT || gates[gates.length - 1].t) - gates[0].t) / 3.6e6) : 0;
    const signals = [
      { key: 'ceremony_share', text: gates.length >= 3
        ? `${gates.length} heavy gate runs in ${hours < 1 ? `${Math.round(hours * 60)} min` : `${Math.round(hours * 10) / 10} h`}`
        : `${Math.round(f.ceremony_share * 100)}% of recent commands are process ceremony (gates, review bookkeeping, re-merges)` },
      { key: 'new_files', text: `${f.new_files} new file${f.new_files === 1 ? '' : 's'} in the last ${f.actions} actions` },
      { key: 'waits_per_action', text: `${f.waits} waits on helpers or running commands across the last ${f.actions} actions` },
      { key: 'skel_rep', text: `${Math.round(f.skel_rep * 100)}% of commands repeat a recent command shape` },
    ].map(item => ({ w: terms[item.key] || 0, text: item.text }));
    const strong = signals.filter(item => item.w >= 0.7);
    const extra = signals.filter(item => item.w < 0.7 && item.w >= 0.5).sort((a, b) => b.w - a.w).slice(0, Math.max(0, 2 - out.length - strong.length));
    out.push(...strong, ...extra);
  }
  if (state.streak.c >= 5 && state.streak.poll) out.push({ w: 0.5, text: `waiting: the same check ${state.streak.c} times in a row` });
  if (state.source === 'claude' && assessment.uncapped !== assessment.level) out.push({ w: 0, text: `capped at ${assessment.level} for Claude Code (less calibrated)` });
  return out.sort((a, b) => b.w - a.w).map(item => item.text).slice(0, 5);
}
function compactTrail(state) {
  return state.ring.slice(-TRAIL).map(item => {
    const row = { t: item.t, op: item.o === 'c' ? 'cmd' : item.o === 'e' ? 'edit' : 'spawn' };
    if (item.k) row.cmd = item.k;
    if (item.f) row.file = item.f;
    if (item.x != null) row.outcome = item.x === 0 ? 'ok' : `exit ${item.x}`;
    if (item.e) row.err = item.e;
    if (item.c) row.ceremony = true;
    return row;
  });
}
function touchEpisode(state, ep) {
  ep.updated = true;
  const out = outbox(state);
  if (!out.episodes.includes(ep)) out.episodes.push(ep);
}
function evaluate(state, cfg, t) {
  const c = config(cfg);
  state.lastT = t == null ? state.lastT : t;
  const a = assess(state, c);
  state.score = Math.round(a.score * 1000) / 1000;
  const windowClosed = state.windowClosed; state.windowClosed = false;
  if (a.level !== state.level) {
    const why = reasons(state, c, a);
    outbox(state).changes.push({ from: state.level, to: a.level, t: state.lastT, score: state.score, reasons: why, n: state.n });
    state.level = a.level; state.levelT = state.lastT;
  }
  if (state.ep && state.lastT - state.ep.lastHotT > 12 * 3600000) closeEpisode(state, state.ep.lastHotT, 'inactive');
  if (rank(a.level) > 0) {
    if (!state.ep) openEpisode(state, c, a);
    const ep = state.ep;
    ep.lastHotT = state.lastT; ep.calmWindows = 0;
    if (rank(a.level) > rank(ep.peakLevel) || (rank(a.level) === rank(ep.peakLevel) && a.score > ep.peakScore + 0.005)) {
      ep.peakLevel = rank(a.level) >= rank(ep.peakLevel) ? a.level : ep.peakLevel;
      ep.peakScore = Math.max(ep.peakScore, Math.round(a.score * 1000) / 1000);
      ep.peakT = state.lastT; ep.reasons = reasons(state, c, a); ep.trail = compactTrail(state);
      touchEpisode(state, ep);
    }
  } else if (state.ep && windowClosed) {
    state.ep.calmWindows++;
    if (state.ep.calmWindows >= 2) closeEpisode(state, state.lastT, 'calm');
  }
}
function openEpisode(state, c, a) {
  const t = state.lastT;
  state.ep = {
    id: `${state.source}-${state.id}-${t}`, threadId: state.id, source: state.source, start: t, startN: state.n,
    peakT: t, peakScore: Math.round(a.score * 1000) / 1000, peakLevel: a.level, reasons: [], end: null, endReason: null,
    lastHotT: t, calmWindows: 0, history: [[t, Math.round(a.score * 1000) / 1000, a.level]], trail: [],
    humans: state.humans.filter(h => h.t >= t - 3 * 3600000).slice(-6), callouts: [], merged: null,
  };
  state.ep.reasons = reasons(state, c, a); state.ep.trail = compactTrail(state);
  touchEpisode(state, state.ep);
}
function closeEpisode(state, end, why) {
  const ep = state.ep; if (!ep) return;
  ep.end = end; ep.endReason = why;
  state.lastClosed = { id: ep.id, end, merged: ep.merged, callouts: ep.callouts.length };
  outbox(state).closed.push(ep);
  touchEpisode(state, ep);
  state.ep = null;
  state.notified.desktop = 'calm'; state.notified.nudge = 'calm';
}
function outcomeOf(ep, { now = Date.now(), lastSeen = null } = {}) {
  if (ep.callouts && ep.callouts.length) return 'user called it out';
  if (ep.merged) return 'merged';
  if (ep.end != null) return ep.endReason === 'calm' ? 'converged' : 'abandoned';
  const seen = lastSeen || ep.lastHotT || ep.start;
  return now - seen > 12 * 3600000 ? 'abandoned' : 'still running';
}

// ---------------------------------------------------------------------------
// human messages and callouts
// ---------------------------------------------------------------------------
function addHuman(state, t, text, cfg) {
  const value = String(text || '');
  if (state.lastHuman && Math.abs(state.lastHuman.t - t) < 10000 && state.lastHuman.head === value.slice(0, 50)) return;
  state.lastHuman = { t, head: value.slice(0, 50) };
  if (state.ep && t - state.ep.lastHotT > 12 * 3600000) closeEpisode(state, state.ep.lastHotT, 'inactive');
  if (!state.firstRequest && !/^\s*(<|# AGENTS\.md|<environment_context)/.test(value)) state.firstRequest = value.replace(/\s+/g, ' ').trim().slice(0, 200);
  const entry = { t, text: value.replace(/\s+/g, ' ').trim().slice(0, 300), who: state.isRoot ? 'user' : 'parent agent' };
  state.humans.push(entry);
  if (state.humans.length > 12) state.humans.splice(0, state.humans.length - 12);
  if (state.ep) { state.ep.humans.push(entry); if (state.ep.humans.length > 20) state.ep.humans.splice(6, 1); touchEpisode(state, state.ep); }
  if (state.isRoot && isCallout(value)) {
    const callout = { t, text: entry.text.slice(0, 200), level: state.level, score: state.score };
    state.callouts.push(callout);
    if (state.callouts.length > 50) state.callouts.splice(0, state.callouts.length - 50);
    outbox(state).callouts.push(callout);
    const closed = state.lastClosed && t - state.lastClosed.end <= 12 * 3600000 ? state.lastClosed : null;
    if (state.ep) { callout.episode = state.ep.id; state.ep.callouts.push(callout); touchEpisode(state, state.ep); }
    else if (closed) { callout.episode = closed.id; closed.callouts++; outbox(state).updates.push({ id: closed.id, callout }); }
    else outbox(state).misses.push(callout);
  }
  evaluate(state, cfg, t);
}

// ---------------------------------------------------------------------------
// raw transcript lines (extract.js), resumable
// ---------------------------------------------------------------------------
const SKIP_KEYS = ['"type":"compacted"', '"world_state"', '"type":"reasoning"', 'token_usage_record', '"item":{"type":"Reasoning"',
  '"type":"token_count"', '"type":"api-request', '"type":"attachment"', '"type":"turn_context"'];
const tsOf = (r, state) => { const x = Date.parse(r.timestamp); return Number.isNaN(x) ? state.lastT : x; };
function firstErrLine(out) {
  if (!out) return '';
  const lines = String(out).split('\n', 400);
  const skip = /^(Chunk ID|Wall time|Process exited|Original token count|Output:|Script completed|Exit code)/;
  for (const l of lines) { const t = l.trim(); if (t && !skip.test(t) && /(error|fail|cannot|can't|not found|denied|fatal|exception|ERR!|panic|refused|timed? ?out|no such|invalid|unexpected|conflict|rejected)/i.test(t)) return t.slice(0, 160); }
  for (const l of lines) { const t = l.trim(); if (t && !skip.test(t)) return t.slice(0, 160); }
  return '';
}
function outText(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map(x => (x && (x.text || x.content)) || (typeof x === 'string' ? x : '')).join('\n');
  if (typeof o === 'object') return o.output || o.text || o.content || JSON.stringify(o).slice(0, 4000);
  return String(o);
}
function parseApplyPatch(input) {
  const files = [];
  for (const l of String(input).split('\n')) { const m = l.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/); if (m) files.push(m[2].trim()); }
  return files;
}
function inferredExit(cmd, err) {
  if (READLIKE.test(stripPrefixes(cmd || ''))) return 0;
  return err && INF_ERR.test(err) && !OK_RE.test(err) ? 1 : 0;
}

// Pre-scan a chunk so fallback (response_item) actions are dropped once the
// item-based records start (the 60-second rule the calibration used).
function prescan(state, text) {
  if (state.source !== 'codex') return;
  for (const [field, marker] of [['firstCmdT', '"type":"CommandExecution"'], ['firstEditT', '"type":"FileChange"']]) {
    if (state[field] != null) continue;
    let at = text.indexOf(marker);
    while (at >= 0) {
      const start = text.lastIndexOf('\n', at) + 1;
      const head = text.slice(start, Math.min(text.length, start + 400));
      if (head.includes('item_completed') || text.slice(start, at).includes('item_completed')) {
        const m = head.match(/"timestamp":"([^"]+)"/);
        if (m && !Number.isNaN(Date.parse(m[1]))) { state[field] = Date.parse(m[1]); break; }
      }
      at = text.indexOf(marker, at + marker.length);
    }
  }
}

function ingestLine(state, line, cfg) {
  if (!line || line.length < 2) return;
  const head = line.slice(0, 320);
  for (const k of SKIP_KEYS) if (head.includes(k)) return;
  let r; try { r = JSON.parse(line); } catch (_) { state.corrupt = (state.corrupt || 0) + 1; return; }
  if (!r || typeof r !== 'object') return;
  if (state.source === 'codex') codexRecord(state, r, cfg); else claudeRecord(state, r, cfg);
}
function ingestText(state, text, cfg, { budgetMs = Infinity, started = Date.now() } = {}) {
  // returns the number of characters consumed (whole lines only)
  prescan(state, text);
  let pos = 0, lines = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break;
    ingestLine(state, text.slice(pos, nl), cfg);
    pos = nl + 1;
    if ((++lines & 63) === 0 && Date.now() - started > budgetMs) break;
  }
  return pos;
}

function applyMeta(state, p, t) {
  state.parent = p.parent_thread_id || state.parent || null;
  const sub = typeof p.source === 'object' && p.source !== null;
  state.isRoot = !state.parent && !sub;
  if (p.cwd) state.cwd = p.cwd;
  if (p.id && !state.id) state.id = p.id;
  if (state.startT == null) state.startT = t;
  state.agentPath = p.agent_path || (p.source && p.source.subagent && JSON.stringify(p.source.subagent).slice(0, 200)) || state.agentPath;
  if (!state.root && state.parent) state.root = state.parent;
}

function codexRecord(state, r, cfg) {
  const t = tsOf(r, state);
  const p = r.payload || {};
  if (t != null) state.lastT = Math.max(state.lastT || 0, t) || t;
  if (r.type === 'session_meta') { applyMeta(state, p, t); return; }
  if (r.type === 'event_msg') {
    if (p.type === 'user_message') { addHuman(state, t, String(p.message || '').slice(0, 3000), cfg); return; }
    if (p.type !== 'item_completed') return;
    const it = p.item || {};
    if (it.type === 'UserMessage') { addHuman(state, t, (it.content || []).map(x => x.text || '').join('\n').slice(0, 3000), cfg); return; }
    if (it.type === 'CommandExecution') {
      if (state.firstCmdT == null) state.firstCmdT = t;
      const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : String(it.command || '');
      let exit = it.exit_code; if (exit == null && it.status && it.status !== 'completed') exit = -1;
      const out = it.aggregated_output || it.formatted_output || ((it.stdout || '') + (it.stderr || ''));
      addAction(state, { t, op: 'cmd', cmd, exit: exit == null ? null : Number(exit), err: exit == null || Number(exit) !== 0 ? firstErrLine(out) : '' }, cfg);
      return;
    }
    if (it.type === 'FileChange') {
      if (state.firstEditT == null) state.firstEditT = t;
      for (const file of Object.keys(it.changes || {})) addAction(state, { t, op: 'edit', file }, cfg);
      return;
    }
    if (it.type === 'SubAgentActivity' && it.kind === 'started' && !state.spawnIds.includes(it.id)) {
      addAction(state, { t, op: 'spawn', name: String(it.agent_path || '').split('/').pop() }, cfg);
    }
    return;
  }
  if (r.type !== 'response_item') return;
  if (p.type === 'message' && p.role === 'assistant') { addAgentText(state, (p.content || []).map(x => x.text || '').join('\n')); return; }
  if (p.type === 'function_call') {
    const name = p.name; let args = {}; try { args = JSON.parse(p.arguments || '{}'); } catch (_) {}
    if (name === 'spawn_agent') { state.spawnIds.push(p.call_id); if (state.spawnIds.length > 50) state.spawnIds.shift(); addAction(state, { t, op: 'spawn', name: args.task_name || args.agent_type || '' }, cfg); return; }
    if (name === 'followup_task') { addAction(state, { t, op: 'spawn', name: String(args.target || '').split('/').pop() }, cfg); return; }
    if (name === 'wait' || name === 'wait_agent' || name === 'write_stdin') { addWait(state); return; }
    if (name === 'exec_command' || name === 'shell' || name === 'local_shell') {
      let cmd = args.cmd || args.command; if (Array.isArray(cmd)) cmd = cmd[cmd.length - 1];
      setPending(state, p.call_id, { t, kind: 'cmd', cmds: [String(cmd || '').slice(0, 600)] });
    }
    return;
  }
  if (p.type === 'custom_tool_call') {
    const input = String(p.input || '');
    if (p.name === 'apply_patch') { setPending(state, p.call_id, { t, kind: 'patch', files: parseApplyPatch(input) }); return; }
    if (p.name !== 'exec') return;
    const writes = (input.match(/tools\.write_stdin\(/g) || []).length;
    for (let i = 0; i < writes; i++) addWait(state);
    if (state.firstCmdT != null && state.firstEditT != null && t >= Math.max(state.firstCmdT, state.firstEditT) - 60000) return;
    const cmds = []; let m;
    const unq = q => { if (q[0] === '"') { try { return JSON.parse(q); } catch (_) {} } return q.slice(1, -1).replace(/\\(.)/g, '$1'); };
    const re = /["']?\bcmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g;
    while ((m = re.exec(input))) cmds.push(unq(m[1]));
    if (!cmds.length && /exec_command/.test(input)) {
      const re3 = /\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)\s*,/g;
      while ((m = re3.exec(input))) cmds.push(unq(m[1]));
    }
    const others = [...new Set((input.match(/tools\.([A-Za-z0-9_]+)\(/g) || []).map(x => x.slice(6, -1)).filter(x => !['exec_command', 'write_stdin', 'apply_patch', 'update_plan'].includes(x)))];
    for (const o of others) cmds.push('tool:' + o);
    if (!cmds.length && !/apply_patch|write_stdin|update_plan/.test(input)) cmds.push('js: ' + input.replace(/\s+/g, ' ').slice(0, 200));
    const files = [];
    const re2 = /apply_patch\(\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*")/g;
    while ((m = re2.exec(input))) { let s = m[1]; try { s = s[0] === '"' ? JSON.parse(s) : s.slice(1, -1); } catch (_) {} files.push(...parseApplyPatch(s)); }
    if (cmds.length || files.length) setPending(state, p.call_id, { t, kind: 'exec', cmds: cmds.map(x => String(x).slice(0, 600)), files });
    return;
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const call = state.pending[p.call_id]; if (!call) return;
    delete state.pending[p.call_id];
    const out = outText(p.output);
    let exit = null; const m = out.match(/Process exited with code (-?\d+)/) || out.match(/^Exit code:? (-?\d+)/m) || out.match(/\bexit(?:ed with)? code:? (-?\d+)/i);
    if (m) exit = Number(m[1]);
    const keepCmd = state.firstCmdT == null || call.t < state.firstCmdT - 60000;
    const keepEdit = state.firstEditT == null || call.t < state.firstEditT - 60000;
    if (call.kind === 'cmd' && keepCmd) fallbackCmd(state, call.t, call.cmds[0], exit, out, cfg);
    else if (call.kind === 'patch' && keepEdit) for (const file of call.files) addAction(state, { t: call.t, op: 'edit', file }, cfg);
    else if (call.kind === 'exec') {
      const codes = [...out.matchAll(/"exit_code"\s*:\s*(-?\d+)/g)].map(x => Number(x[1]));
      const nc = call.cmds.length;
      if (keepCmd) call.cmds.forEach((cmd, i) => {
        let e = null;
        if (codes.length === nc) e = codes[i]; else if (i === nc - 1) e = codes.length ? codes[codes.length - 1] : exit;
        fallbackCmd(state, call.t, cmd, e, i === nc - 1 ? out : '', cfg);
      });
      if (keepEdit) for (const file of call.files) addAction(state, { t: call.t, op: 'edit', file }, cfg);
    }
  }
}
function setPending(state, id, call) {
  if (!id) return;
  state.pending[id] = call;
  trimKeys(state.pending, 40);
}
function fallbackCmd(state, t, cmd, exit, out, cfg) {
  const err = exit == null || exit !== 0 ? firstErrLine(out) : '';
  // old Codex exec outputs carry no exit code: infer from the first error-looking line
  addAction(state, { t, op: 'cmd', cmd, exit: exit == null ? inferredExit(cmd, err) : exit, err }, cfg);
}

function blocks(m) { const c = m && m.content; if (typeof c === 'string') return [{ type: 'text', text: c }]; return Array.isArray(c) ? c : []; }
function claudeRecord(state, r, cfg) {
  if (r.type !== 'user' && r.type !== 'assistant') return;
  const t = tsOf(r, state);
  if (t != null) state.lastT = Math.max(state.lastT || 0, t) || t;
  if (state.startT == null) state.startT = t;
  if (r.cwd && !state.cwd) state.cwd = r.cwd;
  const m = r.message || {};
  if (r.type === 'assistant') {
    for (const b of blocks(m)) {
      if (b.type === 'text' && b.text) addAgentText(state, b.text);
      if (b.type !== 'tool_use') continue;
      if (state.toolIds.includes(b.id)) continue;
      state.toolIds.push(b.id); if (state.toolIds.length > 300) state.toolIds.splice(0, 100);
      const inp = b.input || {}, nm = b.name;
      if (nm === 'TodoWrite') continue;
      if (nm === 'Agent' || nm === 'Task') { addAction(state, { t, op: 'spawn', name: inp.description || inp.subagent_type || '' }, cfg); continue; }
      if (nm === 'TaskOutput' || nm === 'BashOutput' || /^Monitor/.test(nm)) addWait(state);
      if (nm === 'Edit' || nm === 'MultiEdit' || nm === 'Write' || nm === 'NotebookEdit') {
        addAction(state, { t, op: 'edit', file: inp.file_path || inp.notebook_path || '' }, cfg); continue;
      }
      let cmd;
      if (nm === 'Bash') cmd = String(inp.command || '');
      else if (nm === 'Read') cmd = `Read ${inp.file_path || ''}${inp.offset ? ' offset ' + inp.offset : ''}${inp.limit ? ' limit ' + inp.limit : ''}`;
      else if (nm === 'Grep') cmd = `Grep ${inp.pattern || ''} ${inp.path || ''} ${inp.glob || ''}`;
      else if (nm === 'Glob') cmd = `Glob ${inp.pattern || ''} ${inp.path || ''}`;
      else cmd = `${nm} ${JSON.stringify(inp).slice(0, 300)}`;
      addAction(state, { t, op: 'cmd', cmd, exit: null, id: b.id, bash: nm === 'Bash' }, cfg);
    }
    return;
  }
  const bl = blocks(m);
  for (const b of bl) {
    if (b.type !== 'tool_result' || !Object.hasOwn(state.pend, b.tool_use_id)) continue;
    const index = state.pend[b.tool_use_id]; delete state.pend[b.tool_use_id];
    const out = outText(b.content);
    const mm = out.match(/^Exit code (-?\d+)/m);
    const exit = mm ? Number(mm[1]) : (b.is_error ? 1 : 0);
    const item = state.ring[state.ring.length - (state.n - index)];
    if (item && item.o === 'c') {
      item.x = exit;
      if (exit !== 0) item.e = firstErrLine(out).slice(0, 120);
      if (exit === 0 && item.k && config(cfg)._compiled.merge.test(item.k)) noteMerge(state, t);
    }
  }
  if (r.isMeta || r.toolUseResult) return;
  const texts = bl.filter(b => b.type === 'text').map(b => b.text || '');
  if (!texts.length) return;
  const txt = texts.join('\n');
  if (/^\s*<(system-reminder|local-command|task-notification|command-message|command-name)/.test(txt)) return;
  if (/^Caveat: The messages below/.test(txt)) return;
  addHuman(state, t, txt.slice(0, 3000), cfg);
}

// Repository label from a working directory: worktrees fold back to their checkout.
function repoOf(cwd) {
  if (!cwd) return '';
  const m = String(cwd).match(/^(.*?)\/(?:\.worktrees|\.codex\/worktrees|\.claude\/worktrees|worktrees)\//);
  const base = (m ? m[1] : String(cwd)).replace(/\/+$/, '');
  return base.split('/').pop() || '';
}

function nudgeText(reasonsList) {
  return `Spin check: ${(reasonsList || []).join('; ') || 'sustained churn-like pattern'}. Pause and post to the user: the original goal, what is concretely left, and whether another round/gate is worth it. Continue only if you can justify it.`;
}

module.exports = {
  DEFAULT_CONFIG, DEFAULT_CEREMONY_PATTERNS, DEFAULT_GATE_PATTERNS, DEFAULT_MERGE_PATTERNS, DEFAULT_REVIEW_HELPER_PATTERNS, LEVELS, WINDOW, SPAN, SUSTAIN, TRAIL, FEATURES,
  rank, config, mergeConfig, percentile, scoreOf, skeleton, stripPrefixes, isPoll, isCallout, h32,
  newState, ingestLine, ingestText, prescan, addAction, addHuman, addAgentText, addWait,
  assess, reasons, rolled, sustainedScore, outcomeOf, takeOutbox, repoOf, nudgeText, compactTrail, closeEpisode,
};
