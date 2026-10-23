'use strict';

// Maps the spin watch episode archive onto the Attention Brief's finding shape.
// Spin findings come from the archive written by the optional hook (and the
// backfill), not from the investigation index, so they are not limited by
// Release Two's session and event caps and survive transcript deletion.
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./spin-store');
const { scorerVersion, versionOf } = require('./spin-version');
const activity = require('./ui/spin-activity');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const investigationKey = (source, file) => crypto.createHash('sha256').update(`${source}:${file}`).digest('hex').slice(0, 32);
const RECENT_MS = 24 * 3600000;
const exists = file => { try { return !!file && fs.statSync(file).isFile(); } catch (_) { return false; } };

function episodeEnd(ep, thread, now) {
  if (ep.end != null) return ep.end;
  return activity.lastActivity(ep, thread, now);
}

function helperName(thread) {
  const raw = String(thread.agentPath || '');
  const m = raw.match(/"agent_path"\s*:\s*"([^"]+)"/) || raw.match(/([A-Za-z0-9_./-]+)$/);
  return m ? m[1].split('/').filter(Boolean).pop() : '';
}
// The outcome (and, for an open episode, active / idle / abandoned) is worked
// out here, at request time, from the thread's last recorded activity and the
// current time; nothing time-dependent is frozen into the archive.
function toFinding(thread, ep, { now = Date.now(), sessions = new Map(), archived = false, threads = new Map(), scorer = null, settings = null } = {}) {
  const transcript = exists(thread.file);
  const scoredBy = ep.scorer || versionOf(thread);
  const key = transcript ? investigationKey(thread.source, thread.file) : null;
  const indexed = key && sessions.get(key);
  const limits = activity.thresholds(settings);
  const state = activity.describe(ep, { now, thread, settings: limits });
  const outcome = state.label;
  const level = ep.peakLevel === 'alert' ? 'alert' : 'watch';
  const reasons = ep.reasons && ep.reasons.length ? ep.reasons : ['sustained churn-like pattern'];
  const tool = thread.source === 'claude' ? 'Claude Code' : 'Codex';
  const session = key || `spin:${thread.source}:${thread.threadId}`;
  const rootThread = thread.root && thread.root !== thread.threadId ? threads.get(`${thread.source}:${thread.root}`) : null;
  const rootTitle = rootThread && (rootThread.title || rootThread.firstRequest);
  const helper = thread.isRoot === false ? `Helper agent${helperName(thread) ? ` ${helperName(thread)}` : ''}${rootTitle ? ` · ${rootTitle}` : ''}` : '';
  const useful = value => value && value !== thread.threadId && !/^\s*(?:#|<)/.test(value) ? value : '';
  const sessionTitle = useful(indexed && indexed.title) || useful(thread.title) || helper || useful(thread.firstRequest) || thread.threadId;
  const to = episodeEnd(ep, thread, now);
  const trail = ep.trail || [];
  const evidence = trail.slice(-12).map((item, index) => ({
    id: null, session, kind: item.op === 'edit' ? 'change' : item.op === 'spawn' ? 'spawn' : 'tool', name: item.op,
    ts: item.t ? new Date(item.t).toISOString() : null,
    text: [item.cmd || item.file || '', item.err || item.outcome || ''].filter(Boolean).join(' → ').slice(0, 220), index,
  }));
  return {
    id: hash(`spin:${ep.id}`), rule: 'spin', severity: level === 'alert' ? 'high' : 'medium',
    repo: (indexed && indexed.repo) || thread.repo || 'Unknown repository', cwd: (indexed && indexed.cwd) || thread.cwd || '',
    session, sessionId: thread.threadId, sessionTitle, from: ep.start, to,
    title: `Spin ${level}: ${reasons.slice(0, 2).join(' · ')}`,
    trigger: reasons.join('; '),
    rationale: `${tool} kept a churn-like pattern over its last ~120 actions (peak score ${Number(ep.peakScore || 0).toFixed(2)}; watch ≥ 0.70, alert ≥ 0.85, plus review-round and back-to-back repeat rules). In the calibration study, sessions like this were mostly review-round or merge-gate treadmills made of commands that succeed.`,
    uncertainty: `Calibrated on a small set of hand-labeled sessions, so this is a prompt to look, not proof. Long legitimate gates and human-paced work can look similar, and scope drift is hard to see.${thread.source === 'claude' ? ' Claude Code is less calibrated and is capped at watch by default.' : ''}`,
    evidence, evidenceCount: trail.length,
    spin: {
      episodeId: ep.id, level, peakLevel: ep.peakLevel, peakScore: ep.peakScore, peakAt: ep.peakT, outcome,
      activity: { state: state.state, lastActivity: state.lastActivity, ...limits },
      reasons, history: ep.history || [], trail, humans: ep.humans || [], callouts: ep.callouts || [], merged: ep.merged || null,
      threadId: thread.threadId, source: thread.source, root: thread.root || null, parent: thread.parent || null,
      isRoot: thread.isRoot !== false, file: thread.file || null, transcriptDeleted: !transcript, indexed: !!indexed,
      archived, label: thread.label || null, open: state.open, firstRequest: thread.firstRequest || '',
      scorer: scoredBy, earlierScorer: !!scorer && scoredBy !== scorer, rescorePending: !!scorer && scoredBy !== scorer && transcript,
    },
  };
}

function createSpinBrief({ paths = store.paths() } = {}) {
  function threads() { return store.listArchive(paths); }
  const current = () => scorerVersion(store.loadConfig(paths, { create: false }));
  // Live mode: one finding per thread (its latest episode in the interval).
  // Archive mode: every archived episode, newest first.
  function findings({ since = 0, archive = false, now = Date.now(), sessions = [], repo = '' } = {}) {
    const bySession = new Map(sessions.map(item => [item.key, item]));
    const all = threads();
    const byThread = new Map(all.map(thread => [`${thread.source}:${thread.threadId}`, thread]));
    const cfg = store.loadConfig(paths, { create: false });
    const scorer = scorerVersion(cfg), limits = cfg.activity;
    const out = [];
    for (const thread of all) {
      const episodes = (thread.episodes || []).filter(ep => ep && ep.start != null && !ep.superseded);
      if (!episodes.length) continue;
      if (repo && !`${thread.repo || ''} ${thread.cwd || ''}`.toLowerCase().includes(String(repo).toLowerCase())) continue;
      if (archive) { for (const ep of episodes) out.push(toFinding(thread, ep, { now, sessions: bySession, archived: true, threads: byThread, scorer, settings: limits })); continue; }
      const inRange = episodes.filter(ep => !since || episodeEnd(ep, thread, now) >= since);
      if (!inRange.length) continue;
      const latest = inRange[inRange.length - 1];
      const finding = toFinding(thread, latest, { now, sessions: bySession, threads: byThread, scorer, settings: limits });
      finding.spin.otherEpisodes = inRange.length - 1;
      out.push(finding);
    }
    return out.sort((a, b) => (b.to || 0) - (a.to || 0));
  }
  function summary({ now = Date.now() } = {}) {
    const items = findings({ since: now - RECENT_MS, now }).map(f => ({ id: f.id, level: f.spin.level, open: f.spin.open, to: f.to,
      title: f.sessionTitle, repo: f.repo, source: f.spin.source, outcome: f.spin.outcome, activity: f.spin.activity }));
    return { items, count: items.length, alerts: items.filter(i => i.level === 'alert').length, windowHours: RECENT_MS / 3600000 };
  }
  function archiveStats() {
    const list = threads();
    const size = store.archiveSize(paths);
    return { ...size, threads: list.length, misses: list.reduce((n, t) => n + (t.misses || []).length, 0),
      labels: list.filter(t => t.label).length };
  }
  // Which threads still carry scores from an earlier scorer version. Read only:
  // nothing is rescored here; the backfill (or "Rescore now") does that.
  let versionCache = null;
  function versions({ now = Date.now() } = {}) {
    const scorer = current();
    let manifestStamp = 0; try { manifestStamp = fs.statSync(paths.manifestFile).mtimeMs; } catch (_) {}
    const archive = threads();
    const key = `${scorer}:${manifestStamp}:${archive.length}:${archive.reduce((n, t) => Math.max(n, t.updatedAt || 0), 0)}`;
    if (!versionCache || versionCache.key !== key || now - versionCache.at > 30000) {
      const pending = new Set(), earlier = new Set();
      const manifest = store.readManifest(paths);
      for (const [file, entry] of Object.entries(manifest.files)) if (versionOf(entry) !== scorer && exists(file)) pending.add(file);
      for (const thread of archive) {
        const stale = (thread.episodes || []).some(ep => !ep.superseded && (ep.scorer || versionOf(thread)) !== scorer);
        if (!stale) continue;
        if (exists(thread.file)) pending.add(thread.file); else earlier.add(`${thread.source}:${thread.threadId}`);
      }
      versionCache = { key, at: now, value: { current: scorer, pendingThreads: pending.size, earlierArchivedThreads: earlier.size } };
    }
    return { ...versionCache.value, rescore: rescoreStatus({ now }) };
  }
  function rescoreStatus({ now = Date.now() } = {}) {
    const progress = store.readJson(paths.progressFile, null);
    if (!progress) return { running: false };
    let alive = false; try { process.kill(progress.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    const running = !progress.finishedAt && alive && now - (progress.updatedAt || 0) < 120000;
    const { done = 0, total = 0, bytesDone = 0, bytesTotal = 0, startedAt = null, finishedAt = null, scorer = null } = progress;
    return { running, done, total, bytesDone, bytesTotal, startedAt, finishedAt, scorer };
  }
  function getConfig() {
    return { config: store.loadConfig(paths), configFile: paths.configFile, stateDir: paths.stateDir, archive: archiveStats(),
      hookInstalled: hookInstalled() };
  }
  function putConfig(input) { return store.saveConfig(paths, input); }
  function hookInstalled() {
    const has = file => { try { return fs.readFileSync(file, 'utf8').includes('spin-hook.js'); } catch (_) { return false; } };
    return { claude: has(require('node:path').join(paths.claudeHome, 'settings.json')), codex: has(require('node:path').join(paths.codexHome, 'hooks.json')) };
  }
  return { findings, summary, getConfig, putConfig, archiveStats, versions, rescoreStatus, current };
}

// One card per session: findings from other rules on the same session and
// overlapping time span become supporting evidence under its spin finding.
function nestUnderSpin(spinFindings, others, slackMs = 30 * 60000) {
  const remaining = [];
  const bySession = new Map();
  for (const f of spinFindings) { f.supporting = f.supporting || []; if (!bySession.has(f.session)) bySession.set(f.session, []); bySession.get(f.session).push(f); }
  for (const f of others) {
    const owners = bySession.get(f.session) || [];
    const owner = owners.find(s => (f.to == null || f.to >= (s.from || 0) - slackMs) && (f.from == null || f.from <= (s.to || Infinity) + slackMs));
    if (owner) owner.supporting.push(f); else remaining.push(f);
  }
  return remaining;
}

module.exports = { createSpinBrief, toFinding, nestUnderSpin, investigationKey };
