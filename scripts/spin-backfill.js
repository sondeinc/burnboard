#!/usr/bin/env node
'use strict';

// Scores every available Codex and Claude Code transcript with the spin watch
// scorer, as if the hook had fired after every action, and writes the episode
// archive under ~/.local/state/burnboard/spin/episodes/. Root sessions are
// always archived; helper sub-agents only when they ran 200+ actions. Optional
// local hand labels (seed-labels.json in the state directory, or
// BURNBOARD_SPIN_SEED_LABELS) are seeded onto their threads with their notes.
//
// Re-running only does the work that is needed. Each transcript is accounted
// for in a manifest keyed by its path, with the scorer version that scored it
// (a hash of the scoring code, reference quantiles and scoring settings):
//   - unchanged (same size/mtime, same scorer version) → skipped
//   - fully consumed by the live hook at the current version → skipped
//   - grown since it was scored → scored incrementally from its stored state
//   - scored by an earlier version, rewritten, or never scored → full replay
// Episodes a full replay no longer produces are kept and marked superseded.
// Archived episodes whose transcripts were deleted are left untouched, with
// the version that scored them. --force rescores everything in full.
//
//   node scripts/spin-backfill.js [--force] [--workers 6] [--seed-state-days 3] [--quiet] [--json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const spin = require('../lib/spin');
const store = require('../lib/spin-store');
const { replayFile, listTranscripts, idOf, CLOSE_IDLE_MS } = require('../lib/spin-replay');
const { scorerVersion, versionOf } = require('../lib/spin-version');
const MIN_SUBAGENT_ACTIONS = 200;

// Continues a stored scorer state from its byte offset (the same work the hook
// does live, without its time budget or tail skipping).
function resumeFile(job, cfg, now) {
  const state = job.state;
  state.out = null;
  state.offset = store.feed(state, job.file, state.offset, job.size, spin.config(cfg));
  state.size = job.size; state.file = job.file;
  if (state.ep && now - (state.lastT || 0) > CLOSE_IDLE_MS) spin.closeEpisode(state, state.ep.lastHotT, 'inactive');
  return { state, out: spin.takeOutbox(state) };
}

if (!isMainThread) {
  const cfg = spin.config(workerData.config);
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    try {
      if (job.mode === 'resume') {
        const startOffset = job.state.offset;
        const result = resumeFile(job, cfg, workerData.now);
        parentPort.postMessage({ ok: true, job: { ...job, state: undefined, startOffset }, mode: 'resume', result });
      } else {
        const result = replayFile(job.file, job.source, cfg, { now: workerData.now });
        result.state.scorer = workerData.scorer;
        parentPort.postMessage({ ok: true, job, mode: 'replay', result });
      }
    } catch (error) { parentPort.postMessage({ ok: false, job: { ...job, state: undefined }, error: String(error && error.stack || error) }); }
  });
} else if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

// One backfill at a time (a pid lock; a dead holder's lock is replaced).
function runLock(p) {
  const file = path.join(p.stateDir, 'backfill.lock');
  fs.mkdirSync(p.stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return () => { try { fs.unlinkSync(file); } catch (_) {} }; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false; try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive && pid !== process.pid) return null;
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
  return null;
}

// Decides what each transcript needs; reads stored states, writes nothing.
function plan(p, transcripts, manifest, scorer, { force = false } = {}) {
  const jobs = [], skipped = [], counts = { found: transcripts.length, unchanged: 0, consumed: 0, resume: 0, replay: 0, reasons: {} };
  for (const item of transcripts) {
    let st; try { st = fs.statSync(item.file); } catch (_) { continue; }
    const entry = manifest.files[item.file];
    if (!force && entry && entry.scorer === scorer && entry.size === st.size && entry.mtimeMs === st.mtimeMs) { counts.unchanged++; continue; }
    const id = idOf(item.file, item.source);
    const state = force ? null : store.loadState(p, item.source, id);
    const current = !!state && versionOf(state) === scorer;
    const sameFile = !!state && state.ino === st.ino && state.offset <= st.size;
    if (current && sameFile && state.offset >= st.size) {
      counts.consumed++;
      skipped.push({ file: item.file, entry: { size: st.size, mtimeMs: st.mtimeMs, scorer, offset: state.offset, source: item.source, id } });
      continue;
    }
    if (current && sameFile && Array.isArray(state.ring)) {
      counts.resume++;
      jobs.push({ ...item, id, mode: 'resume', state, size: st.size, mtimeMs: st.mtimeMs, work: st.size - state.offset });
      continue;
    }
    const reason = force ? 'forced'
      : (state && !current) || (entry && entry.scorer !== scorer) ? 'earlier scorer version'
        : state && !sameFile ? 'transcript rewritten' : entry ? 'no stored state' : 'new transcript';
    counts.replay++; counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
    jobs.push({ ...item, id, mode: 'replay', reason, size: st.size, mtimeMs: st.mtimeMs, work: st.size });
  }
  return { jobs, skipped, counts };
}

async function main(argv = process.argv.slice(2)) {
  const processStarted = Date.now();
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const force = argv.includes('--force'), quiet = argv.includes('--quiet');
  const workers = Math.max(1, Number(opt('--workers', Math.max(1, Math.min(8, os.cpus().length - 2)))));
  const seedStateDays = Number(opt('--seed-state-days', 3));
  const p = store.paths({ stateDir: opt('--state', undefined), codexHome: opt('--codex-home', undefined), claudeHome: opt('--claude-home', undefined) });
  const log = (...args) => { if (!quiet) console.log(...args); };
  const release = runLock(p);
  if (!release) { log('spin backfill: another backfill is already running'); return { alreadyRunning: true }; }
  try { return await run({ p, force, workers, seedStateDays, log, argv, processStarted }); }
  finally { release(); }
}

async function run({ p, force, workers, seedStateDays, log, argv, processStarted }) {
  const cfg = store.loadConfig(p);
  const scorer = scorerVersion(cfg);
  const now = Date.now();
  // Migrate the manifest in place, keeping a copy of the pre-version format.
  const raw = store.readJson(p.manifestFile, null);
  const manifest = store.migrateManifest(raw);
  if (raw && raw.v !== 2) {
    const backup = p.manifestFile.replace(/\.json$/, '.v1.json');
    if (!fs.existsSync(backup)) fs.copyFileSync(p.manifestFile, backup);
    store.writeManifest(p, manifest);
  }
  const all = listTranscripts(p).filter(item => cfg.sources[item.source] !== false);
  const { jobs, skipped, counts } = plan(p, all, manifest, scorer, { force });
  for (const item of skipped) manifest.files[item.file] = item.entry;
  jobs.sort((a, b) => b.work - a.work);
  const totalBytes = jobs.reduce((a, j) => a + j.work, 0);
  log(`spin backfill (scorer ${scorer}): ${all.length} transcripts found; ${counts.unchanged + counts.consumed} unchanged (skipped), `
    + `${counts.resume} grown (incremental), ${counts.replay} to score in full (${(totalBytes / 1e9).toFixed(2)} GB to read) with ${workers} workers`);
  if (counts.replay) log(`  full rescore reasons: ${Object.entries(counts.reasons).map(([k, v]) => `${v} ${k}`).join(', ')}`);

  // Progress for the dashboard ("Rescoring spin threads … 34%").
  const progress = { pid: process.pid, phase: 'rescore', scorer, startedAt: now, updatedAt: Date.now(), done: 0, total: jobs.length, bytesDone: 0, bytesTotal: totalBytes, counts };
  const writeProgress = () => { progress.updatedAt = Date.now(); try { store.atomicWrite(p.progressFile, progress); } catch (_) {} };
  writeProgress();
  const results = [];
  let failed = 0, lastWrite = 0;
  const started = Date.now();
  await new Promise(resolve => {
    if (!jobs.length) return resolve();
    let next = 0;
    const pool = [];
    for (let i = 0; i < Math.min(workers, jobs.length); i++) {
      const worker = new Worker(__filename, { workerData: { config: cfg, now, scorer } });
      pool.push(worker);
      const feed = () => {
        if (next < jobs.length) worker.postMessage(jobs[next++]);
        else worker.postMessage(null);
      };
      worker.on('message', message => {
        progress.done++; progress.bytesDone += message.job.work;
        if (message.ok) results.push(message); else { failed++; store.logError(p, message.error, `backfill ${message.job.file}`); }
        if (Date.now() - lastWrite > 1000) { lastWrite = Date.now(); writeProgress(); }
        if (progress.done % 200 === 0 || progress.done === jobs.length) log(`  ${progress.done}/${jobs.length} files, ${(progress.bytesDone / 1e9).toFixed(2)} GB, ${((Date.now() - started) / 1000).toFixed(0)} s`);
        feed();
      });
      worker.on('error', error => { store.logError(p, error, 'backfill worker'); });
      feed();
    }
    let exited = 0;
    for (const worker of pool) worker.on('exit', () => { if (++exited === pool.length) resolve(); });
  });

  // Codex parent links are only known after every session header was read.
  const parents = new Map();
  for (const { result } of results) parents.set(`${result.state.source}:${result.state.id}`, result.state.parent || null);
  for (const archived of store.listArchive(p)) if (archived.threadId && !parents.has(`${archived.source}:${archived.threadId}`)) parents.set(`${archived.source}:${archived.threadId}`, archived.parent || null);
  const rootOf = (source, id) => {
    let current = id, guard = 0;
    while (guard++ < 20) { const parent = parents.get(`${source}:${current}`); if (!parent) return current; current = parent; }
    return current;
  };
  const titles = codexTitles(p);
  let archivedThreads = 0, episodes = 0, misses = 0, savedStates = 0;
  for (const { job, mode, result } of results) {
    const state = result.state;
    if (state.source === 'codex') { state.root = rootOf('codex', state.id); state.title = titles.get(state.id) || state.title; state.titleChecked = true; }
    const eligible = state.isRoot || state.n >= MIN_SUBAGENT_ACTIONS;
    if (eligible && mode === 'replay') {
      const written = store.writeReplay(p, state, result.episodes, state.isRoot ? result.callouts : [], state.isRoot ? result.misses : [], { now });
      if (written) { archivedThreads++; episodes += result.episodes.length; misses += state.isRoot ? result.misses.length : 0; }
    }
    if (eligible && mode === 'resume') {
      const out = state.isRoot ? result.out : { ...result.out, callouts: [], misses: [] };
      const written = store.recordThread(p, state, out, { now });
      if (written) { archivedThreads++; episodes += new Set([...out.episodes, ...out.closed]).size; misses += out.misses.length; }
    }
    // Keep every thread's scorer state, so a grown transcript resumes from
    // here next time instead of being replayed from the start.
    const release = store.lock(store.statePath(p, state.source, state.id), { waitMs: 500 });
    if (release) {
      try {
        const existing = store.loadState(p, state.source, state.id);
        const advancedMeanwhile = existing && existing.ino === state.ino && versionOf(existing) === scorer
          && existing.offset > (mode === 'resume' ? job.startOffset : state.offset);
        if (!advancedMeanwhile) {
          if (existing && existing.ino === state.ino) state.notified = existing.notified || state.notified;
          // An old thread's replayed level is history, not news: don't toast it if the hook resumes it.
          else if (mode === 'replay' && now - job.mtimeMs > seedStateDays * 86400000) state.notified = { desktop: state.level, desktopAt: now, nudge: state.level };
          store.saveState(p, state); savedStates++;
        }
      } finally { release(); }
    }
    manifest.files[job.file] = { size: job.size, mtimeMs: job.mtimeMs, scorer, offset: state.offset, source: state.source, id: state.id };
  }
  let seeded = 0;
  for (const label of store.loadSeedLabels(p)) {
    const hit = results.find(item => item.result.state.id === label.id);
    if (store.seedLabel(p, label, hit ? store.threadHeader(hit.result.state) : {})) seeded++;
  }
  store.writeManifest(p, manifest);
  if (cfg.episodes.retentionDays != null) store.prune(p, cfg.episodes.retentionDays, now);
  const size = store.archiveSize(p);
  const summary = { scorer, found: all.length, skipped: counts.unchanged + counts.consumed, unchanged: counts.unchanged, consumedByHook: counts.consumed,
    incremental: counts.resume, rescored: counts.replay, rescoreReasons: counts.reasons, failed, archivedThreads, episodes, misses, savedStates,
    labelsSeeded: seeded, seconds: Math.round((Date.now() - processStarted) / 100) / 10, archive: size };
  Object.assign(progress, { finishedAt: Date.now(), summary }); writeProgress();
  log(`done in ${summary.seconds} s: ${summary.skipped} skipped, ${summary.incremental} scored incrementally, ${summary.rescored} rescored in full, ${failed} failed`);
  log(`archived ${archivedThreads} threads with ${episodes} new or updated episodes; ${misses} callouts with no episode (misses); ${savedStates} scorer states saved; ${seeded} labels seeded`);
  log(`archive now: ${size.files} thread files, ${size.episodes} episodes, ${(size.bytes / 1e6).toFixed(1)} MB in ${p.episodesDir}`);
  if (argv.includes('--json')) console.log(JSON.stringify(summary));
  return summary;
}

function codexTitles(p) {
  const out = new Map();
  try {
    for (const line of fs.readFileSync(path.join(p.codexHome, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      try { const row = JSON.parse(line); if (row.id && row.thread_name) out.set(row.id, row.thread_name); } catch (_) {}
    }
  } catch (_) {}
  return out;
}

module.exports = { main, plan, resumeFile };
