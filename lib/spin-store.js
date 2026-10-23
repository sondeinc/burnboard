'use strict';

// Spin watch storage: config, per-thread scorer state, the append-only level
// event log, and the durable episode archive. Shared by the hook, the backfill
// script and the dashboard server. Every write is atomic (tmp + rename); every
// per-thread mutation runs under a short non-blocking lock file so concurrent
// hook invocations never interleave.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spin = require('./spin');
const { versionOf, UNVERSIONED } = require('./spin-version');
const activity = require('./ui/spin-activity');

const HOME = os.homedir();
const LEVEL_NAMES = new Set(spin.LEVELS);
const MAX_ARCHIVE_EPISODES = 200;

function paths(overrides = {}) {
  const stateDir = overrides.stateDir || process.env.BURNBOARD_SPIN_STATE || path.join(HOME, '.local', 'state', 'burnboard', 'spin');
  return {
    stateDir,
    configFile: overrides.configFile || process.env.BURNBOARD_SPIN_CONFIG || path.join(HOME, '.config', 'burnboard', 'spin.json'),
    sessionsDir: path.join(stateDir, 'sessions'),
    episodesDir: path.join(stateDir, 'episodes'),
    eventsFile: path.join(stateDir, 'events.jsonl'),
    manifestFile: path.join(stateDir, 'backfill-manifest.json'),
    progressFile: path.join(stateDir, 'backfill-progress.json'),
    errorsFile: path.join(stateDir, 'hook-errors.log'),
    pathsFile: path.join(stateDir, 'paths.json'),
    seedLabelsFile: overrides.seedLabelsFile || process.env.BURNBOARD_SPIN_SEED_LABELS || path.join(stateDir, 'seed-labels.json'),
    codexHome: overrides.codexHome || process.env.CODEX_HOME || path.join(HOME, '.codex'),
    claudeHome: overrides.claudeHome || path.join(HOME, '.claude'),
  };
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

// Non-blocking lock: returns null when another invocation holds it. Locks older
// than staleMs are presumed abandoned (a killed hook) and replaced.
function lock(file, { staleMs = 10000, waitMs = 0 } = {}) {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lockFile); } catch (_) {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) { fs.unlinkSync(lockFile); continue; } } catch (_) { continue; }
      if (Date.now() >= deadline) return null;
      const until = Date.now() + 25; while (Date.now() < until) { /* brief spin for backfill writers */ }
    }
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
// Card wording only (active / idle / abandoned); deliberately not part of the
// scorer version. Absent from older spin.json files, so it falls back to defaults.
function activitySetting(input, key, fallback) {
  const group = input && typeof input === 'object' && input.activity && typeof input.activity === 'object' ? input.activity : {};
  return group[key] == null || group[key] === '' ? fallback : group[key];
}
function validateConfig(input) {
  const errors = [];
  const c = spin.mergeConfig(spin.DEFAULT_CONFIG, input && typeof input === 'object' ? input : {});
  const level = (value, name, fallback) => {
    if (LEVEL_NAMES.has(value) && value !== 'calm') return value;
    errors.push(`${name} must be "watch" or "alert"`); return fallback;
  };
  const number = (value, name, fallback, min, max) => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    errors.push(`${name} must be a number from ${min} to ${max}`); return fallback;
  };
  const D = spin.DEFAULT_CONFIG;
  const patterns = name => {
    const list = c[name];
    if (Array.isArray(list) && list.every(p => typeof p === 'string')) {
      for (const pattern of list) { try { new RegExp(pattern); } catch (_) { errors.push(`${name} entry is not a valid regular expression: ${pattern}`); } }
      return list;
    }
    errors.push(`${name} must be a list of strings`); return D[name];
  };
  const out = {
    enabled: c.enabled !== false,
    desktop: { enabled: c.desktop.enabled !== false, minLevel: level(c.desktop.minLevel, 'desktop.minLevel', D.desktop.minLevel),
      cooldownMinutes: number(c.desktop.cooldownMinutes, 'desktop.cooldownMinutes', D.desktop.cooldownMinutes, 0, 10080) },
    agentNudge: { mode: ['off', 'shadow', 'nudge'].includes(c.agentNudge.mode) ? c.agentNudge.mode : (errors.push('agentNudge.mode must be off, shadow or nudge'), D.agentNudge.mode),
      minLevel: level(c.agentNudge.minLevel, 'agentNudge.minLevel', D.agentNudge.minLevel) },
    thresholds: {
      watch: number(c.thresholds.watch, 'thresholds.watch', D.thresholds.watch, 0, 1),
      alert: number(c.thresholds.alert, 'thresholds.alert', D.thresholds.alert, 0, 1),
      reviewRoundWatch: number(c.thresholds.reviewRoundWatch, 'thresholds.reviewRoundWatch', D.thresholds.reviewRoundWatch, 1, 1000),
      reviewRoundAlert: number(c.thresholds.reviewRoundAlert, 'thresholds.reviewRoundAlert', D.thresholds.reviewRoundAlert, 1, 1000),
      backToBackRepeat: number(c.thresholds.backToBackRepeat, 'thresholds.backToBackRepeat', D.thresholds.backToBackRepeat, 2, 1000),
    },
    claudeMaxLevel: ['calm', 'watch', 'alert'].includes(c.claudeMaxLevel) ? c.claudeMaxLevel : (errors.push('claudeMaxLevel must be calm, watch or alert'), D.claudeMaxLevel),
    ceremonyPatterns: patterns('ceremonyPatterns'),
    gatePatterns: patterns('gatePatterns'),
    mergePatterns: patterns('mergePatterns'),
    reviewHelperPatterns: patterns('reviewHelperPatterns'),
    sources: { codex: c.sources.codex !== false, claude: c.sources.claude !== false },
    episodes: { retentionDays: c.episodes.retentionDays == null || c.episodes.retentionDays === '' ? null
      : number(c.episodes.retentionDays, 'episodes.retentionDays', null, 1, 36500) },
    activity: {
      activeMinutes: number(activitySetting(input, 'activeMinutes', activity.DEFAULT_ACTIVE_MINUTES), 'activity.activeMinutes', activity.DEFAULT_ACTIVE_MINUTES, 1, 1440),
      abandonHours: number(activitySetting(input, 'abandonHours', activity.DEFAULT_ABANDON_HOURS), 'activity.abandonHours', activity.DEFAULT_ABANDON_HOURS, 1, 8760),
    },
    dashboardUrl: typeof c.dashboardUrl === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(c.dashboardUrl) ? c.dashboardUrl.replace(/\/$/, '') : (errors.push('dashboardUrl must be a localhost URL'), D.dashboardUrl),
  };
  if (out.activity.abandonHours * 60 <= out.activity.activeMinutes) errors.push('activity.abandonHours must be longer than activity.activeMinutes');
  if (out.thresholds.alert < out.thresholds.watch) errors.push('thresholds.alert must be at least thresholds.watch');
  if (out.thresholds.reviewRoundAlert < out.thresholds.reviewRoundWatch) errors.push('thresholds.reviewRoundAlert must be at least thresholds.reviewRoundWatch');
  return { config: out, errors };
}
function loadConfig(p = paths(), { create = true } = {}) {
  const saved = readJson(p.configFile, null);
  if (!saved) {
    const fresh = validateConfig({}).config;
    if (create) { try { atomicWrite(p.configFile, JSON.stringify(fresh, null, 2) + '\n'); } catch (_) {} }
    return fresh;
  }
  return validateConfig(saved).config;
}
function saveConfig(p, input) {
  const { config, errors } = validateConfig(input);
  if (errors.length) return { errors };
  atomicWrite(p.configFile, JSON.stringify(config, null, 2) + '\n');
  return { config };
}

// ---------------------------------------------------------------------------
// per-thread scorer state
// ---------------------------------------------------------------------------
const safeId = value => String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const statePath = (p, source, id) => path.join(p.sessionsDir, `${source}-${safeId(id)}.json`);
const episodePath = (p, source, id) => path.join(p.episodesDir, `${source}-${safeId(id)}.json`);
function loadState(p, source, id) {
  const state = readJson(statePath(p, source, id), null);
  return state && state.v === 1 ? state : null;
}
function saveState(p, state) {
  const copy = { ...state }; delete copy.out; delete copy.trace;
  atomicWrite(statePath(p, state.source, state.id), copy);
}

function appendEvent(p, event) {
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.appendFileSync(p.eventsFile, JSON.stringify(event) + '\n');
}
// Actual agent nudges are durable delivery receipts in events.jsonl. Shadow
// entries are intentionally excluded: they describe what would have been sent,
// not context returned to an agent. Keep an exact lifetime count per thread and
// only bound the history carried into a card.
function readNudges(p = paths(), { historyLimit = 200 } = {}) {
  const byThread = new Map();
  let text; try { text = fs.readFileSync(p.eventsFile, 'utf8'); } catch (_) { return byThread; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch (_) { continue; }
    if (event.type !== 'nudge' || !event.threadId || !['codex', 'claude'].includes(event.source)) continue;
    const t = Number(event.ts || event.at);
    if (!Number.isFinite(t) || t <= 0) continue;
    const key = `${event.source}:${event.threadId}`;
    const record = byThread.get(key) || { count: 0, items: [] };
    record.count++;
    record.items.push({ t, level: event.level || null, message: String(event.message || '') });
    if (record.items.length > historyLimit) record.items.splice(0, record.items.length - historyLimit);
    byThread.set(key, record);
  }
  return byThread;
}
function logError(p, error, context = '') {
  try {
    fs.mkdirSync(p.stateDir, { recursive: true });
    try { if (fs.statSync(p.errorsFile).size > 1 << 20) fs.renameSync(p.errorsFile, p.errorsFile + '.1'); } catch (_) {}
    fs.appendFileSync(p.errorsFile, `${new Date().toISOString()} ${context} ${error && error.stack || error}\n`);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// transcripts: streaming reads from a byte offset
// ---------------------------------------------------------------------------
// Reads whole lines in [start, end) into the scorer. Returns the byte offset
// after the last complete line consumed (a trailing partial line is left for
// the next call).
function feed(state, file, start, end, cfg, { budgetMs = Infinity, started = Date.now(), chunk = 8 << 20 } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = start, carry = Buffer.alloc(0);
    const buffer = Buffer.alloc(Math.min(chunk, Math.max(1, end - start)));
    while (offset + carry.length < end) {
      const want = Math.min(buffer.length, end - offset - carry.length);
      const n = fs.readSync(fd, buffer, 0, want, offset + carry.length);
      if (!n) break;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n);
      const last = data.lastIndexOf(10);
      if (last < 0) { carry = Buffer.from(data); if (carry.length > 64 << 20) { offset += carry.length; carry = Buffer.alloc(0); } continue; }
      const text = data.toString('utf8', 0, last + 1);
      const used = spin.ingestText(state, text, cfg, { budgetMs, started });
      const usedBytes = used === text.length ? last + 1 : Buffer.byteLength(text.slice(0, used));
      offset += usedBytes;
      carry = usedBytes < last + 1 ? Buffer.alloc(0) : Buffer.from(data.subarray(last + 1));
      if (usedBytes < last + 1) break; // time budget reached mid-chunk
      if (Date.now() - started > budgetMs) break;
    }
    return offset;
  } finally { fs.closeSync(fd); }
}
function lineBoundaryAfter(file, position) {
  if (position <= 0) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let at = position;
    while (true) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, at);
      if (!n) return at;
      const i = buffer.subarray(0, n).indexOf(10);
      if (i >= 0) return at + i + 1;
      at += n;
    }
  } finally { fs.closeSync(fd); }
}
// Reads only the session header (and the first request) of a transcript whose
// tail is being scored without its beginning.
function readHead(state, file, cfg, bytes = 1 << 20) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buffer, 0, bytes, 0);
    const text = buffer.toString('utf8', 0, n);
    const probe = spin.newState({ source: state.source, id: state.id, file });
    probe.isRoot = state.isRoot;
    for (const line of text.split('\n').slice(0, -1)) {
      if (!line.includes('session_meta') && !line.includes('"user"') && !line.includes('user_message') && !line.includes('UserMessage')) continue;
      spin.ingestLine(probe, line, cfg);
      if (probe.firstRequest && (state.source !== 'codex' || probe.startT != null)) break;
    }
    for (const key of ['parent', 'root', 'isRoot', 'cwd', 'startT', 'agentPath', 'firstRequest']) if (probe[key] != null && probe[key] !== '') state[key] = probe[key];
    state.humans = []; state.callouts = [];
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------
// titles and roots
// ---------------------------------------------------------------------------
function codexTitle(p, id) {
  try {
    const text = fs.readFileSync(path.join(p.codexHome, 'session_index.jsonl'), 'utf8');
    let title = '';
    for (const line of text.split('\n')) if (line.includes(id)) { try { const row = JSON.parse(line); if (row.id === id && row.thread_name) title = row.thread_name; } catch (_) {} }
    return title;
  } catch (_) { return ''; }
}
function resolveRoot(p, state) {
  if (!state.parent) return state.isRoot ? state.id : state.root;
  const parent = loadState(p, state.source, state.parent);
  if (parent) return parent.root || parent.id;
  const archived = readJson(episodePath(p, state.source, state.parent), null);
  return (archived && (archived.root || archived.threadId)) || state.parent;
}

// ---------------------------------------------------------------------------
// episode archive
// ---------------------------------------------------------------------------
function threadHeader(state) {
  return {
    threadId: state.id, source: state.source, file: state.file, cwd: state.cwd || '', repo: spin.repoOf(state.cwd),
    title: state.title || '', firstRequest: state.firstRequest || '', parent: state.parent || null,
    root: state.root || (state.isRoot ? state.id : null), isRoot: !!state.isRoot, agentPath: state.agentPath || null,
    startT: state.startT, lastSeen: state.lastT, actions: state.n, scorer: versionOf(state),
  };
}
// Every archived episode records the scorer version that produced it.
// Its stored outcome is only a snapshot word ("active" or a closed outcome);
// the Brief recomputes active / idle / abandoned at request time.
function serializeEpisode(ep, now, scorer, lastSeen) {
  const copy = { ...ep }; delete copy.updated; delete copy.calmWindows;
  copy.outcome = activity.describe(ep, { now, thread: { lastSeen } }).state;
  copy.scorer = scorer || ep.scorer || UNVERSIONED;
  return copy;
}
// Superseded episodes (an earlier scorer found them, the current one does not)
// are kept, flagged, and capped separately; they never count as findings.
function capEpisodes(list) {
  const sorted = list.sort((a, b) => a.start - b.start);
  const active = sorted.filter(ep => !ep.superseded).slice(-MAX_ARCHIVE_EPISODES);
  const superseded = sorted.filter(ep => ep.superseded).slice(-MAX_ARCHIVE_EPISODES);
  return [...active, ...superseded].sort((a, b) => a.start - b.start);
}
function mergeEpisodes(existing, incoming, now, scorer, lastSeen) {
  const byId = new Map((existing || []).map(ep => [ep.id, ep]));
  for (const ep of incoming) byId.set(ep.id, serializeEpisode(ep, now, scorer, lastSeen));
  return capEpisodes([...byId.values()]);
}
function dedupeByTime(list, max = 200) {
  const seen = new Set(), out = [];
  for (const item of list || []) { const key = `${item.t}:${String(item.text || '').slice(0, 40)}`; if (!seen.has(key)) { seen.add(key); out.push(item); } }
  return out.sort((a, b) => a.t - b.t).slice(-max);
}
// The header's lastSeen is the newest transcript event seen for the thread
// (any action or message). It only moves forward.
const newest = (...times) => { const list = times.filter(t => Number.isFinite(t) && t > 0); return list.length ? Math.max(...list) : null; };
// While a thread has an open episode, its lastSeen is refreshed at least this
// often even when nothing else in the episode changed, so the Brief can tell
// an active thread from an idle one.
const SEEN_REFRESH_MS = 30000;
// Live (incremental) archive update for one thread.
function recordThread(p, state, out, { now = Date.now() } = {}) {
  const touched = new Set([...out.episodes, ...out.closed]);
  const quiet = !touched.size && !out.updates.length && !out.misses.length && !out.callouts.length;
  if (quiet && !state.ep) return null;
  const file = episodePath(p, state.source, state.id);
  if (quiet) {
    const stored = readJson(file, null);
    if (!stored || !((state.lastT || 0) - (stored.lastSeen || 0) >= SEEN_REFRESH_MS)) return null;
  }
  const release = lock(file, { waitMs: 300 });
  if (!release) return null;
  try {
    const existing = readJson(file, null);
    if (quiet && !existing) return null;
    const current = existing || { v: 1, episodes: [], callouts: [], misses: [], label: null };
    const next = { ...current, ...threadHeader(state), title: state.title || current.title || '' };
    next.lastSeen = newest(current.lastSeen, state.lastT);
    next.episodes = mergeEpisodes(current.episodes, [...touched], now, versionOf(state), next.lastSeen);
    for (const update of out.updates) {
      const ep = next.episodes.find(item => item.id === update.id); if (!ep) continue;
      if (update.merged && !ep.merged) ep.merged = update.merged;
      if (update.callout) ep.callouts = dedupeByTime([...(ep.callouts || []), update.callout], 50);
      ep.outcome = activity.describe(ep, { now, thread: next }).state;
    }
    next.callouts = dedupeByTime([...(current.callouts || []), ...out.callouts]);
    next.misses = dedupeByTime([...(current.misses || []), ...out.misses]);
    next.updatedAt = now;
    atomicWrite(file, next);
    return next;
  } finally { release(); }
}
// Full-replay archive write (backfill). The replay is authoritative for every
// episode its transcript covers; labels and notes survive. Episodes the replay
// no longer produces (e.g. after a scorer change) are kept and marked
// superseded, never deleted.
function writeReplay(p, state, episodes, callouts, misses, { now = Date.now() } = {}) {
  const file = episodePath(p, state.source, state.id);
  const current = readJson(file, null);
  if (!episodes.length && !callouts.length && !current) return null;
  const release = lock(file, { waitMs: 2000 });
  try {
    const base = readJson(file, null) || { v: 1, label: null };
    const next = { ...base, ...threadHeader(state), title: state.title || base.title || '' };
    next.lastSeen = newest(base.lastSeen, state.lastT);
    const replayStart = state.startT || 0;
    const scorer = versionOf(state);
    const fresh = new Set(episodes.map(ep => ep.id));
    const keep = (base.episodes || []).map(ep => {
      if (fresh.has(ep.id) || ep.superseded || (ep.end || ep.lastHotT || ep.start) < replayStart) return ep; // older than this transcript
      return { ...ep, scorer: versionOf(ep), superseded: { at: now, by: scorer } };
    });
    next.episodes = mergeEpisodes(keep, episodes, now, scorer, next.lastSeen);
    next.callouts = dedupeByTime(callouts);
    next.misses = dedupeByTime(misses);
    next.backfilledAt = now; next.updatedAt = now;
    atomicWrite(file, next);
    return next;
  } finally { if (release) release(); }
}
// Optional hand labels ({ labels: [{ id, source, group, label, note, ... }] })
// from your own review of past threads. They are local data: nothing ships with
// burnboard, and everything works without the file.
function loadSeedLabels(p = paths()) {
  const raw = readJson(p.seedLabelsFile, null);
  const labels = raw && Array.isArray(raw.labels) ? raw.labels : [];
  return labels.filter(label => label && typeof label.id === 'string' && (label.source === 'codex' || label.source === 'claude'));
}
function seedLabel(p, label, header = {}) {
  const file = episodePath(p, label.source, label.id);
  const release = lock(file, { waitMs: 2000 });
  try {
    const existing = readJson(file, null);
    const current = existing || { v: 1, threadId: label.id, source: label.source, episodes: [], callouts: [], misses: [], ...header };
    const next = { group: label.group, label: label.label, note: label.note, userLabel: label.userLabel, studyPeak: label.studyPeak,
      callouts: label.callouts, origin: (existing && existing.label && existing.label.origin) || label.origin || 'seed labels' };
    if (existing && existing.threadId && JSON.stringify(existing.label) === JSON.stringify(next)) return false; // already seeded
    current.label = next;
    if (!current.threadId) current.threadId = label.id;
    atomicWrite(file, current);
    return true;
  } finally { if (release) release(); }
}

const archiveCache = new Map();
function listArchive(p = paths()) {
  let names = [];
  try { names = fs.readdirSync(p.episodesDir).filter(name => name.endsWith('.json')); } catch (_) { return []; }
  const out = [], live = new Set();
  for (const name of names) {
    const file = path.join(p.episodesDir, name);
    live.add(file);
    let st; try { st = fs.statSync(file); } catch (_) { continue; }
    const cached = archiveCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) { out.push(cached.value); continue; }
    const value = readJson(file, null);
    if (!value) continue;
    archiveCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    out.push(value);
  }
  for (const key of archiveCache.keys()) if (!live.has(key)) archiveCache.delete(key);
  return out;
}
function archiveSize(p = paths()) {
  let bytes = 0, files = 0, episodes = 0;
  try {
    for (const name of fs.readdirSync(p.episodesDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(p.episodesDir, name);
      bytes += fs.statSync(file).size; files++;
      const value = readJson(file, null); episodes += value && value.episodes ? value.episodes.filter(ep => !ep.superseded).length : 0;
    }
  } catch (_) {}
  return { bytes, files, episodes };
}
// Drops archived episodes that ended more than retentionDays ago; files that
// keep only a seed label survive.
function prune(p, retentionDays, now = Date.now()) {
  if (retentionDays == null) return 0;
  const cutoff = now - retentionDays * 86400000; let removed = 0;
  let names = []; try { names = fs.readdirSync(p.episodesDir).filter(name => name.endsWith('.json')); } catch (_) { return 0; }
  for (const name of names) {
    const file = path.join(p.episodesDir, name);
    const value = readJson(file, null); if (!value) continue;
    const episodes = (value.episodes || []).filter(ep => (ep.end || ep.lastHotT || ep.start) >= cutoff);
    const misses = (value.misses || []).filter(miss => miss.t >= cutoff);
    if (episodes.length === (value.episodes || []).length && misses.length === (value.misses || []).length) continue;
    removed += (value.episodes || []).length - episodes.length;
    if (!episodes.length && !misses.length && !value.label) { try { fs.unlinkSync(file); } catch (_) {} continue; }
    atomicWrite(file, { ...value, episodes, misses });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// backfill manifest: one entry per transcript the backfill has accounted for
// ---------------------------------------------------------------------------
// v2: { v: 2, files: { [transcript path]: { size, mtimeMs, scorer, offset, source, id } } }
// v1 (before scorer versions) was the bare map { [path]: { size, mtimeMs } };
// its entries migrate in place as scored by an unversioned (earlier) scorer.
function migrateManifest(raw) {
  if (raw && raw.v === 2 && raw.files && typeof raw.files === 'object') return raw;
  const files = {};
  for (const [file, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.size)) continue;
    files[file] = { ...entry, scorer: entry.scorer || UNVERSIONED };
  }
  return { v: 2, migratedFrom: raw && Object.keys(raw).length ? 1 : null, files };
}
function readManifest(p = paths()) { return migrateManifest(readJson(p.manifestFile, null)); }
function writeManifest(p, manifest) { atomicWrite(p.manifestFile, { ...manifest, v: 2, updatedAt: Date.now() }); }

module.exports = {
  migrateManifest, readManifest, writeManifest, capEpisodes,
  paths, atomicWrite, readJson, lock, validateConfig, loadConfig, saveConfig, statePath, episodePath,
  loadState, saveState, appendEvent, readNudges, logError, feed, lineBoundaryAfter, readHead, codexTitle, resolveRoot,
  threadHeader, recordThread, writeReplay, loadSeedLabels, seedLabel, listArchive, archiveSize, prune, serializeEpisode,
};
