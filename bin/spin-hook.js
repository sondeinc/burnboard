#!/usr/bin/env node
'use strict';

// burnboard spin watch — PostToolUse hook for Codex CLI and Claude Code.
//
//   node bin/spin-hook.js --source codex|claude   (stdin: the hook payload)
//
// Reads only the transcript bytes appended since the last call, updates the
// per-thread spin score, logs level changes, archives episodes, and optionally
// shows a desktop toast or returns an agent nudge. It always exits 0, prints
// nothing except a valid nudge payload, and never blocks or stops an agent.
const started = Date.now();
const HARD_LIMIT_MS = 1000;
const BUDGET_MS = 650;
const TAIL_BYTES = 8 << 20;
const hardStop = setTimeout(() => process.exit(0), HARD_LIMIT_MS);
hardStop.unref();

const fs = require('node:fs');
const path = require('node:path');
const spin = require('../lib/spin');
const store = require('../lib/spin-store');
const notify = require('../lib/spin-notify');
const { scorerVersion } = require('../lib/spin-version');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = []; let size = 0;
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, 300); timer.unref();
    process.stdin.on('data', chunk => { size += chunk.length; if (size <= 4 << 20) chunks.push(chunk); });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

function codexIdTime(id) {
  const hex = String(id || '').replace(/-/g, '').slice(0, 12);
  const ms = parseInt(hex, 16);
  return /^[0-9a-f]{12}$/i.test(hex) && ms > 1.6e12 && ms < 4e12 ? ms : null;
}
// Finds a Codex rollout by thread id. UUIDv7 ids embed their creation time, so
// only the matching day folders (+/- one day) are listed; results are cached.
function locateCodex(p, id) {
  if (!id) return null;
  const cache = store.readJson(p.pathsFile, {}) || {};
  if (cache[id] && fs.existsSync(cache[id])) return cache[id];
  const root = path.join(p.codexHome, 'sessions');
  const at = codexIdTime(id) || Date.now();
  const days = [];
  for (let d = -1; d <= 1; d++) days.push(new Date(at + d * 86400000));
  for (let d = 0; d <= 14; d++) days.push(new Date(Date.now() - d * 86400000));
  const seen = new Set();
  for (const day of days) {
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    if (seen.has(dir)) continue; seen.add(dir);
    let names; try { names = fs.readdirSync(dir); } catch (_) { continue; }
    const hit = names.find(name => name.includes(id) && name.endsWith('.jsonl'));
    if (hit) {
      const file = path.join(dir, hit);
      const keys = Object.keys(cache); if (keys.length > 500) for (const k of keys.slice(0, 100)) delete cache[k];
      cache[id] = file;
      try { store.atomicWrite(p.pathsFile, cache); } catch (_) {}
      return file;
    }
  }
  return null;
}

function resolveTarget(p, source, payload) {
  if (source === 'claude') {
    let file = payload.transcript_path;
    if (!file) return null;
    if (payload.agent_id) {
      const sub = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents', `agent-${payload.agent_id}.jsonl`);
      if (fs.existsSync(sub)) file = sub;
    }
    return { file, id: path.basename(file, '.jsonl'), root: payload.session_id || null, isRoot: !file.includes(`${path.sep}subagents${path.sep}`) };
  }
  const file = payload.transcript_path || locateCodex(p, payload.session_id);
  if (!file) return null;
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return { file, id: m ? m[1] : payload.session_id, root: null, isRoot: null };
}

function eventBase(state, now) {
  return {
    ts: now, source: state.source, threadId: state.id, root: state.root || (state.isRoot ? state.id : null), parent: state.parent || null,
    cwd: state.cwd || '', repo: spin.repoOf(state.cwd), title: state.title || '', firstRequest: state.firstRequest || '', file: state.file,
  };
}

async function main() {
  const p = store.paths();
  const raw = await readStdin();
  const cfg = spin.config(store.loadConfig(p));
  if (!cfg.enabled) return;
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch (error) { store.logError(p, error, 'payload'); return; }
  const source = ['codex', 'claude'].includes(arg('--source')) ? arg('--source') : payload.turn_id ? 'codex' : 'claude';
  if (cfg.sources && cfg.sources[source] === false) return;
  const target = resolveTarget(p, source, payload);
  if (!target || !target.id) return;
  let st; try { st = fs.statSync(target.file); } catch (_) { return; }
  const release = store.lock(store.statePath(p, source, target.id));
  if (!release) return; // another invocation is scoring this thread right now
  let state, out, nudge = null, toast = null;
  const now = Date.now();
  try {
    state = store.loadState(p, source, target.id);
    if (state && (state.ino !== st.ino || st.size < state.offset)) state = null; // rewritten or replaced transcript
    if (!state) {
      state = spin.newState({ source, id: target.id, file: target.file });
      state.scorer = scorerVersion(cfg);
      if (target.isRoot != null) state.isRoot = target.isRoot;
      if (source === 'claude') state.root = target.isRoot ? target.id : target.root;
      if (st.size > TAIL_BYTES) {
        store.readHead(state, target.file, cfg);
        state.offset = store.lineBoundaryAfter(target.file, st.size - TAIL_BYTES);
        state.gapBytes = state.offset; state.tailStart = true;
      }
    } else if (st.size - state.offset > TAIL_BYTES) {
      const skip = store.lineBoundaryAfter(target.file, st.size - TAIL_BYTES);
      state.gapBytes = (state.gapBytes || 0) + (skip - state.offset); state.offset = skip;
    }
    // An existing state always resumes from its byte offset. If it was scored by
    // an earlier scorer version it keeps that stamp, so the Brief can say a
    // rescore is pending; the backfill does the full rescore, never this hook.
    state.file = target.file;
    if (!state.titleChecked && source === 'codex') { state.title = store.codexTitle(p, target.id) || state.title; state.titleChecked = true; }
    state.offset = store.feed(state, target.file, state.offset, st.size, cfg, { budgetMs: Math.max(50, BUDGET_MS - (Date.now() - started)), started: Date.now() });
    state.ino = st.ino; state.size = st.size; state.seenAt = now;
    if (source === 'codex' && state.parent) state.root = store.resolveRoot(p, state);
    out = spin.takeOutbox(state);
    const level = state.level, R = spin.rank;
    const epReasons = ((state.ep && state.ep.reasons && state.ep.reasons.length ? state.ep.reasons : (out.changes.at(-1) || {}).reasons) || [])
      .filter(reason => !/^capped at /.test(reason));
    const desktop = cfg.desktop || {};
    if (desktop.enabled && R(level) >= R(desktop.minLevel) && R(level) > R(state.notified.desktop)
        && now - (state.notified.desktopAt || 0) >= (desktop.cooldownMinutes || 0) * 60000) {
      state.notified.desktop = level; state.notified.desktopAt = now;
      toast = { source, repo: spin.repoOf(state.cwd), title: state.title || state.firstRequest, level, reasons: epReasons };
    }
    const agent = cfg.agentNudge || {};
    if (agent.mode !== 'off' && R(level) >= R(agent.minLevel) && R(level) > R(state.notified.nudge)) {
      state.notified.nudge = level;
      nudge = { mode: agent.mode, level, message: spin.nudgeText(epReasons.slice(0, 4)) };
    }
    store.saveState(p, state);
  } finally { release(); }

  const base = eventBase(state, now);
  for (const change of out.changes) store.appendEvent(p, { type: 'level', ...base, at: change.t, from: change.from, to: change.to, score: change.score, reasons: change.reasons, episode: state.ep ? state.ep.id : null });
  for (const callout of out.callouts) store.appendEvent(p, { type: 'callout', ...base, at: callout.t, text: callout.text, episode: callout.episode || null, miss: !callout.episode });
  store.recordThread(p, state, out, { now });
  if (toast) {
    const result = notify.showToast(toast, { dashboardUrl: cfg.dashboardUrl });
    store.appendEvent(p, { type: 'desktop', ...base, level: toast.level, shown: result.shown, reason: result.reason || null });
  }
  if (nudge) {
    store.appendEvent(p, { type: nudge.mode === 'nudge' ? 'nudge' : 'nudge-shadow', ...base, level: nudge.level, message: nudge.message });
    if (nudge.mode === 'nudge') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge.message } }));
  }
  maybePrune(p, cfg);
}

function maybePrune(p, cfg) {
  const days = cfg.episodes && cfg.episodes.retentionDays;
  if (days == null) return;
  const marker = path.join(p.stateDir, '.pruned');
  try { if (Date.now() - fs.statSync(marker).mtimeMs < 86400000) return; } catch (_) {}
  try { fs.writeFileSync(marker, String(Date.now())); store.prune(p, days); } catch (error) { store.logError(p, error, 'prune'); }
}

main().catch(error => { try { store.logError(store.paths(), error, 'hook'); } catch (_) {} })
  .finally(() => { clearTimeout(hardStop); process.exitCode = 0; });
