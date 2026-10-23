'use strict';

// Replays a whole transcript through the spin scorer as if the hook had fired
// after every action. Used by the backfill and calibration scripts.
const fs = require('node:fs');
const path = require('node:path');
const spin = require('./spin');
const store = require('./spin-store');

const CLOSE_IDLE_MS = 12 * 3600000;

function idOf(file, source) {
  if (source === 'claude') return path.basename(file, '.jsonl');
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return m ? m[1] : path.basename(file, '.jsonl');
}

function replayFile(file, source, cfg, { now = Date.now(), keepChanges = false } = {}) {
  const c = spin.config(cfg);
  const id = idOf(file, source);
  const state = spin.newState({ source, id, file });
  if (source === 'claude') {
    const sub = file.includes(`${path.sep}subagents${path.sep}`);
    state.isRoot = !sub;
    state.root = sub ? path.basename(path.dirname(path.dirname(file))) : id;
    state.parent = sub ? state.root : null;
  }
  const st = fs.statSync(file);
  const episodes = new Map(), callouts = [], misses = [], changes = [];
  const drain = () => {
    const out = spin.takeOutbox(state);
    for (const ep of [...out.episodes, ...out.closed]) episodes.set(ep.id, ep);
    for (const update of out.updates) {
      const ep = episodes.get(update.id); if (!ep) continue;
      if (update.merged && !ep.merged) ep.merged = update.merged;
      if (update.callout) ep.callouts.push(update.callout);
    }
    callouts.push(...out.callouts); misses.push(...out.misses);
    if (keepChanges) changes.push(...out.changes);
  };
  // drain after every chunk; the outbox holds references, so later mutations stay visible
  const fd = fs.openSync(file, 'r');
  let carry = '';
  try {
    const buffer = Buffer.alloc(16 << 20);
    let offset = 0;
    while (offset < st.size) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!n) break;
      offset += n;
      const text = carry + buffer.toString('utf8', 0, n);
      const used = spin.ingestText(state, text, c);
      carry = text.slice(used);
      if (carry.length > 64 << 20) carry = '';
      drain();
    }
    if (carry) {
      let complete = true; try { JSON.parse(carry); } catch (_) { complete = false; }
      if (complete) { spin.ingestText(state, carry + '\n', c); drain(); carry = ''; }
    }
  } finally { fs.closeSync(fd); }
  if (state.ep && now - (state.lastT || 0) > CLOSE_IDLE_MS) { spin.closeEpisode(state, state.ep.lastHotT, 'inactive'); drain(); }
  state.offset = st.size - Buffer.byteLength(carry); state.size = st.size; state.ino = st.ino;
  return { state, episodes: [...episodes.values()].sort((a, b) => a.start - b.start), callouts, misses, changes, size: st.size, mtimeMs: st.mtimeMs };
}

function listTranscripts(p = store.paths()) {
  const out = [];
  const walk = (dir, source) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, source);
      else if (entry.name.endsWith('.jsonl')) out.push({ file: full, source });
    }
  };
  walk(path.join(p.codexHome, 'sessions'), 'codex');
  walk(path.join(p.claudeHome, 'projects'), 'claude');
  return out;
}

module.exports = { replayFile, listTranscripts, idOf, CLOSE_IDLE_MS };
