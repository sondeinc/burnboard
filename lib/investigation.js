'use strict';

// A separate, disposable index. Source transcripts are always opened read-only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = 2;
const MAX_RECORD = 8 * 1024 * 1024;
const MAX_TEXT = 16000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(p => p && (p.text || p.thinking || '')).filter(Boolean).join('\n')
  : value == null ? '' : JSON.stringify(value);

// Byte offsets, including CRLF, stay valid across Unicode and appended records.
async function* records(file, start = 0, end, firstLine = 1) {
  if (end <= start) return;
  let pieces = [], size = 0, offset = start, line = firstLine;
  for await (const chunk of fs.createReadStream(file, { start, end: end - 1 })) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const stop = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(cursor, stop);
      size += part.length;
      if (size <= MAX_RECORD) pieces.push(part);
      else pieces = [];
      if (newline < 0) break;
      yield { offset, length: size + 1, line: line++, terminated: true,
        tooLarge: size > MAX_RECORD, text: size <= MAX_RECORD ? Buffer.concat(pieces).toString('utf8') : '' };
      offset += size + 1; pieces = []; size = 0; cursor = newline + 1;
    }
  }
  if (size) yield { offset, length: size, line, terminated: false,
    tooLarge: size > MAX_RECORD, text: size <= MAX_RECORD ? Buffer.concat(pieces).toString('utf8') : '' };
}

function normalize(o, meta) {
  const ts = o.timestamp || o.message && o.message.timestamp || null;
  const p = o.payload || {};
  const base = { ts, model: o.message && o.message.model || meta.model || null };
  const event = (kind, text, extra = {}) => ({ ...base, kind, text: String(text || ''), ...extra });
  if (meta.source === 'codex') {
    if (o.type === 'response_item') {
      if (p.type === 'message') return [event(p.role === 'user' ? 'human' : 'agent', textOf(p.content), { role: p.role })];
      if (p.type === 'function_call' || p.type === 'custom_tool_call') return [event('tool',
        typeof p.arguments === 'string' ? p.arguments : textOf(p.input), { name: p.name, callId: p.call_id || p.id })];
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return [event('result', textOf(p.output), { callId: p.call_id })];
      if (p.type === 'reasoning') return [event('reasoning', textOf(p.summary) || 'Reasoning content unavailable', { unavailable: !textOf(p.summary) })];
    }
    if (o.type === 'event_msg') {
      if (p.type === 'token_count') {
        const u = p.info && p.info.last_token_usage;
        return [event('usage', textOf(u || p), { tokens: u && u.total_tokens || 0 })];
      }
      if (p.type === 'user_message' || p.type === 'agent_message') return [event(p.type === 'user_message' ? 'human' : 'agent', p.message || p.text)];
      if (p.type === 'context_compacted') return [event('compaction', textOf(p))];
    }
    if (o.type === 'compacted') return [event('compaction', textOf(p))];
    return [event('other', textOf(p), { name: p.type || o.type || 'unknown' })];
  }
  const content = o.message && o.message.content;
  const result = [];
  for (const block of Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []) {
    if (block.type === 'text') result.push(event(o.type === 'user' ? 'human' : 'agent', block.text, { role: o.type }));
    else if (block.type === 'tool_use') result.push(event('tool', textOf(block.input), { name: block.name, callId: block.id }));
    else if (block.type === 'tool_result') result.push(event('result', textOf(block.content), { callId: block.tool_use_id, isError: !!block.is_error }));
    else if (block.type === 'thinking') result.push(event('reasoning', block.thinking || 'Reasoning content unavailable', { unavailable: !block.thinking }));
    else result.push(event('other', textOf(block), { name: block.type || 'unknown' }));
  }
  if (o.message && o.message.usage) {
    const u = o.message.usage;
    result.push(event('usage', textOf(u), { tokens: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((n, k) => n + (+u[k] || 0), 0) }));
  }
  if (!result.length) result.push(event(o.type === 'system' && o.subtype === 'compact_boundary' ? 'compaction' : 'other', textOf(o), { name: o.subtype || o.type || 'unknown' }));
  return result;
}

function identity(o, meta) {
  const p = o.payload || {};
  if (o.type === 'session_meta' && !meta.sawIdentity) {
    meta.sawIdentity = true; meta.id = p.id || meta.id; meta.cwd = p.cwd || null;
    meta.git = p.git || null; meta.parentId = p.parent_thread_id || p.source && p.source.subagent && p.source.subagent.thread_spawn && p.source.subagent.thread_spawn.parent_thread_id || null;
    meta.agent = meta.parentId ? 'subagent' : 'main'; meta.client = p.originator || null; meta.clientVersion = p.cli_version || null;
  } else if (meta.source === 'claude' && o.cwd && !meta.sawIdentity) {
    meta.sawIdentity = true; meta.cwd = o.cwd; meta.git = { branch: o.gitBranch || null };
    meta.clientVersion = o.version || null; meta.agent = o.isSidechain ? 'subagent' : 'main';
    meta.parentId = o.parentSessionId || null;
  }
  const model = o.message && o.message.model || o.type === 'turn_context' && p.model;
  if (model) { meta.model = model; if (!meta.models.includes(model)) meta.models.push(model); }
  if (o.type === 'turn_context') meta.effort = p.effort || p.reasoning_effort || meta.effort;
  if (o.customTitle || o.aiTitle) meta.title = o.customTitle || o.aiTitle;
  const repo = meta.git && (meta.git.repository_url || meta.git.repo);
  meta.repo = repo || meta.cwd && path.basename(meta.cwd) || '';
}

function publicMeta(meta) {
  const { calls, results, segments, seen, ...value } = meta;
  return value;
}

function matchesSession(meta, q) {
  return (!q.session || q.session === meta.key)
    && (!q.id || q.id === meta.id)
    && (!q.parent || q.parent === meta.parentId)
    && (!q.source || q.source === meta.source)
    && (!q.repo || `${meta.repo || ''} ${meta.cwd || ''}`.toLowerCase().includes(q.repo.toLowerCase()))
    && (!q.worktree || (meta.cwd || '').toLowerCase().includes(q.worktree.toLowerCase()))
    && (!q.agent || (meta.agent || '') === q.agent)
    && (!q.model || meta.models.some(m => m.toLowerCase().includes(q.model.toLowerCase())));
}

function createInvestigation({ sources, cacheDir }) {
  const dir = path.join(cacheDir, `v${VERSION}`);
  const docs = new Map();
  let running = null, cancelled = false, lastRefresh = 0, lastLiveRefresh = 0, revision = 0;
  let progress = { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, errors: [], cancelled: false };
  const metaPath = key => path.join(dir, `${key}.json`);
  const loadMeta = key => { try { return JSON.parse(fs.readFileSync(metaPath(key), 'utf8')); } catch (_) { return null; } };
  const atomic = async (file, value) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(value));
    await fs.promises.rename(tmp, file);
  };
  function status() {
    return { version: VERSION, building: !!running, ...progress, sessions: docs.size,
      events: [...docs.values()].reduce((n, m) => n + m.count, 0),
      sources: sources.map(s => ({ id: s.id, root: s.root, watching: s.watching, available: s.looksLikeHome() })),
      maxRecordBytes: MAX_RECORD, previewCharacters: MAX_TEXT, indexedAt: lastRefresh || null, revision };
  }
  async function ingest(file, source, onBytes = () => {}) {
    const st = await fs.promises.stat(file);
    const key = digest(`${source.id}:${file}`).slice(0, 32);
    const known = docs.get(key);
    if (known && known.size === st.size && known.mtime === st.mtimeMs && known.ino === st.ino) return;
    const old = loadMeta(key);
    async function fingerprint(start, length) {
      const fd = await fs.promises.open(file, 'r');
      try { const b = Buffer.alloc(length); const { bytesRead } = await fd.read(b, 0, length, start); return digest(b.subarray(0, bytesRead)); }
      finally { await fd.close(); }
    }
    const append = old && old.version === VERSION && old.ino === st.ino && old.size <= st.size && !old.unterminated
      && (old.size !== st.size || old.mtime === st.mtimeMs)
      && old.headHash === await fingerprint(0, old.fingerprintBytes || 0)
      && old.tailHash === await fingerprint(Math.max(0, old.offset - (old.fingerprintBytes || 0)), old.fingerprintBytes || 0);
    const meta = append ? old : { version: VERSION, key, id: source.fileId(file), source: source.id,
      file, ino: st.ino, offset: 0, lines: 0, count: 0, malformed: 0, oversized: 0, partial: false,
      models: [], segments: [], calls: {}, results: {}, seen: {}, seenCount: 0, replayed: 0, buckets: {}, bucketMs: 60000,
      title: '', agent: 'unknown', minTime: null, maxTime: null };
    meta.partial = false; meta.unterminated = false;
    const start = meta.offset;
    const segmentName = `${key}-${start}-${st.size}-${crypto.randomBytes(4).toString('hex')}.jsonl`;
    const segment = path.join(dir, segmentName);
    const handle = await fs.promises.open(segment + '.tmp', 'w');
    let added = 0;
    try {
      for await (const record of records(file, start, st.size, meta.lines + 1)) {
        if (cancelled) break;
        let o;
        if (!record.tooLarge && record.text.trim()) {
          try { o = JSON.parse(record.text); }
          catch (_) {
            if (!record.terminated) { meta.partial = true; break; }
            meta.malformed++;
          }
        }
        meta.offset = record.offset + record.length; meta.lines = record.line;
        onBytes(meta.offset);
        meta.unterminated = !record.terminated;
        if (record.tooLarge) meta.oversized++;
        if (!record.tooLarge && !record.text.trim()) continue;
        const rawHash = digest(record.text);
        const native = o && (o.uuid || o.event_id);
        const duplicate = native && meta.seen[native] === rawHash;
        if (duplicate) meta.replayed++;
        if (native) {
          if (!Object.hasOwn(meta.seen, native)) meta.seenCount = (meta.seenCount || 0) + 1;
          put(meta.seen, native, rawHash);
          if (meta.seenCount > 12000) {
            for (const id of Object.keys(meta.seen).slice(0, 2000)) delete meta.seen[id];
            meta.seenCount -= 2000;
          }
        }
        if (duplicate) continue;
        if (o && !duplicate) identity(o, meta);
        const events = o ? normalize(o, meta) : [{ kind: record.tooLarge ? 'unavailable' : 'malformed', text: record.tooLarge ? 'Record exceeds the 8 MiB inspection limit' : record.text, ts: null }];
        for (let part = 0; part < events.length; part++) {
          const e = { ...events[part], id: `${key}:${record.offset}:${part}:${rawHash.slice(0, 12)}`,
            session: key, source: source.id, line: record.line, offset: record.offset, length: record.length,
            part, rawHash, originalType: o && o.type || 'unknown', replay: !!duplicate };
          if (e.kind === 'human' && !meta.prompt && e.text.trim() && !e.text.trim().startsWith('<')) meta.prompt = e.text.slice(0, 2000);
          if (!meta.title && meta.prompt) meta.title = meta.prompt.slice(0, 100);
          if (e.callId && e.kind === 'tool') put(meta.calls, e.callId, { id: e.id, ts: e.ts, model: e.model });
          if (e.callId && e.kind === 'result') put(meta.results, e.callId, { id: e.id, ts: e.ts });
          const t = Date.parse(e.ts);
          if (Number.isFinite(t)) {
            meta.minTime = meta.minTime == null ? t : Math.min(meta.minTime, t);
            meta.maxTime = meta.maxTime == null ? t : Math.max(meta.maxTime, t);
            const bin = Math.floor(t / meta.bucketMs) * meta.bucketMs;
            const bucket = meta.buckets[bin] || (meta.buckets[bin] = {});
            bucket[e.kind] = (bucket[e.kind] || 0) + 1;
            if (Object.keys(meta.buckets).length > 2048) {
              meta.bucketMs *= 2; const merged = {};
              for (const [at, values] of Object.entries(meta.buckets)) {
                const k = Math.floor(+at / meta.bucketMs) * meta.bucketMs;
                const target = merged[k] || (merged[k] = {});
                for (const [kind, n] of Object.entries(values)) target[kind] = (target[kind] || 0) + n;
              }
              meta.buckets = merged;
            }
          }
          e.textTruncated = e.text.length > MAX_TEXT; e.text = e.text.slice(0, MAX_TEXT);
          await handle.write(`${JSON.stringify(e)}\n`); added++; meta.count++;
        }
      }
    } finally { await handle.close(); }
    if (cancelled) { await fs.promises.rm(segment + '.tmp', { force: true }); return; }
    if (added) { await fs.promises.rename(segment + '.tmp', segment); meta.segments.push(segmentName); }
    else await fs.promises.rm(segment + '.tmp', { force: true });
    meta.fingerprintBytes = Math.min(4096, meta.offset);
    meta.headHash = await fingerprint(0, meta.fingerprintBytes);
    meta.tailHash = await fingerprint(Math.max(0, meta.offset - meta.fingerprintBytes), meta.fingerprintBytes);
    meta.size = st.size; meta.mtime = st.mtimeMs; meta.indexedAt = Date.now();
    const title = source.titleFor(meta.id);
    if (title) meta.title = title;
    await atomic(metaPath(key), meta);
    docs.set(key, publicMeta(meta));
    revision++;
  }
  function refresh(force = false, recentOnly = false) {
    if (running) return running;
    if (progress.cancelled && !force) return Promise.resolve();
    const refreshedAt = recentOnly ? lastLiveRefresh : lastRefresh;
    if (!force && Date.now() - refreshedAt < (recentOnly ? 750 : 5000)) return Promise.resolve();
    cancelled = false; progress = { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, errors: [], cancelled: false };
    running = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      const files = sources.flatMap(source => {
        if (!recentOnly || typeof source.recentFiles !== 'function') return source.allSessionFiles().map(file => ({ file, source }));
        return source.recentFiles(48 * 3600000).map(item => ({ file: item.fp || item, source }));
      });
      progress.total = files.length;
      // Byte totals make the percentage honest when file sizes are very uneven.
      const sizes = files.map(({ file }) => { try { return fs.statSync(file).size; } catch (_) { return 0; } });
      progress.bytesTotal = sizes.reduce((n, size) => n + size, 0);
      const live = new Set(files.map(({ file, source }) => digest(`${source.id}:${file}`).slice(0, 32)));
      if (!recentOnly) for (const key of docs.keys()) if (!live.has(key)) { docs.delete(key); revision++; }
      for (let i = 0; i < files.length; i++) {
        const { file, source } = files[i];
        if (cancelled) break;
        const base = progress.bytesDone;
        try { await ingest(file, source, bytes => { progress.bytesDone = base + Math.min(bytes, sizes[i]); }); }
        catch (error) { if (progress.errors.length < 20) progress.errors.push({ file, message: error.message }); }
        progress.bytesDone = base + sizes[i];
        progress.done++;
      }
    })().catch(error => { progress.errors.push({ message: error.message }); }).finally(() => {
      progress.cancelled = cancelled;
      if (recentOnly) lastLiveRefresh = Date.now();
      else lastRefresh = lastLiveRefresh = Date.now();
      running = null;
    });
    return running;
  }
  function refreshLive(force = false) { return refresh(force, true); }
  function sessions(q = {}) {
    return [...docs.values()].filter(m => matchesSession(m, q)).sort((a, b) => b.mtime - a.mtime);
  }
  async function* indexed(meta) {
    for (const segment of meta.segments) {
      const file = path.join(dir, path.basename(segment));
      const stat = await fs.promises.stat(file);
      for await (const row of records(file, 0, stat.size)) {
        if (row.text) yield JSON.parse(row.text);
      }
    }
  }
  async function raw(meta, e) {
    if (e.length > MAX_RECORD + 1) throw Object.assign(new Error('Record exceeds the 8 MiB inspection limit'), { status: 413 });
    const handle = await fs.promises.open(meta.file, 'r');
    let buffer;
    try {
      const st = await handle.stat();
      if (st.ino !== meta.ino || st.size < e.offset + e.length) throw Object.assign(new Error('Source record changed; rebuild the index'), { status: 409 });
      buffer = Buffer.alloc(e.length);
      const { bytesRead } = await handle.read(buffer, 0, e.length, e.offset);
      if (bytesRead !== e.length) throw new Error('Source record is incomplete');
    } finally { await handle.close(); }
    let line = buffer.toString('utf8');
    if (line.endsWith('\n')) line = line.slice(0, -1);
    if (digest(line) !== e.rawHash) throw Object.assign(new Error('Source record changed; rebuild the index'), { status: 409 });
    let original = null; try { original = JSON.parse(line); } catch (_) {}
    const full = original && normalize(original, { ...meta, model: e.model })[e.part];
    return { event: { ...e, text: full ? full.text : line, textTruncated: false }, original, raw: line,
      location: { file: meta.file, line: e.line, offset: e.offset, bytes: e.length } };
  }
  async function query(q = {}, signal) {
    const cursor = Math.max(0, Math.min(10000000, parseInt(q.cursor, 10) || 0));
    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 60));
    const result = []; let total = 0, stale = 0;
    const from = q.from && Number(q.from), to = q.to && Number(q.to);
    const needle = (q.q || '').toLowerCase().slice(0, 1000);
    for (const doc of sessions(q)) {
      if (signal && signal.aborted) break;
      const meta = loadMeta(doc.key); if (!meta) continue;
      for await (const row of indexed(meta)) {
        if (signal && signal.aborted) break;
        if (q.event && row.id !== q.event) continue;
        const time = Date.parse(row.ts);
        if ((from && (!Number.isFinite(time) || time < from)) || (to && (!Number.isFinite(time) || time > to))) continue;
        if (q.kind && row.kind !== q.kind) continue;
        if (q.model && !(row.model || '').toLowerCase().includes(q.model.toLowerCase())) continue;
        let text = row.text;
        if (needle && row.textTruncated) {
          try { text = (await raw(meta, row)).event.text; } catch (_) { stale++; }
        }
        const searchable = `${row.name || ''}\n${row.callId || ''}\n${row.originalType || ''}\n${meta.id || ''}\n${meta.file || ''}\n${meta.cwd || ''}\n${meta.repo || ''}\n${text}`.toLowerCase();
        if (needle && !searchable.includes(needle)) continue;
        if (total >= cursor && result.length < limit) {
          const pairs = row.kind === 'tool' ? meta.results : meta.calls;
          const pair = row.callId && Object.hasOwn(pairs, row.callId) ? pairs[row.callId] : null;
          const dt = pair && Date.parse(row.kind === 'tool' ? pair.ts : row.ts) - Date.parse(row.kind === 'tool' ? row.ts : pair.ts);
          let snippet = row.text;
          if (needle) {
            const at = text.toLowerCase().indexOf(needle);
            snippet = text.slice(Math.max(0, at - 100), Math.max(0, at - 100) + 500);
          }
          result.push({ ...row, snippet, linkedEventId: pair && pair.id || null,
            elapsedMs: Number.isFinite(dt) && dt >= 0 ? dt : null,
            sessionTitle: meta.title || meta.id, cwd: meta.cwd || '', repo: meta.repo || '' });
        }
        total++;
        if (q.event && result.length) break;
      }
    }
    return { events: result, total, cursor, next: cursor + result.length < total ? cursor + result.length : null,
      coverage: { building: !!running, indexedSessions: docs.size, staleRecords: stale, recordLimitBytes: MAX_RECORD,
        oversized: [...docs.values()].reduce((n, d) => n + d.oversized, 0), cancelled: progress.cancelled } };
  }
  async function getRaw(session, event) {
    const doc = docs.get(session); if (!doc) return null;
    const meta = loadMeta(session); if (!meta) return null;
    for await (const e of indexed(meta)) if (e.id === event) return raw(meta, e);
    return null;
  }
  async function* sessionEvents(session) {
    const doc = docs.get(session); if (!doc) return;
    const meta = loadMeta(session); if (!meta) return;
    yield* indexed(meta);
  }
  return { refresh, refreshLive, status, sessions, query, getRaw, sessionEvents,
    cancel: () => { cancelled = true; } };
}

module.exports = { createInvestigation, normalize, records, matchesSession, VERSION, MAX_RECORD };
