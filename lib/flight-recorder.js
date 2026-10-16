'use strict';

// Deterministic Release Two analysis. These findings summarize recorded
// evidence; they never execute commands, call a model, or infer hidden state.
const path = require('node:path');
const crypto = require('node:crypto');

const RULES = ['repeated-failure', 'repeated-command', 'long-wait', 'stale-verification', 'unacknowledged-child'];
const MAX_SESSIONS = 300;
const MAX_EVENTS_PER_SESSION = 5000;
const MAX_FINDINGS = 250;
const MAX_OVERLAPS = 200;
const MAX_TRAIL_ITEMS = 200;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const at = event => {
  const value = Date.parse(event.ts);
  return Number.isFinite(value) ? value : null;
};
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

function inputOf(event) {
  const text = String(event.text || '');
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object') return value;
  } catch (_) {}
  return { command: text };
}

function commandOf(event) {
  if (!event || event.kind !== 'tool') return '';
  const input = inputOf(event);
  const value = input.cmd || input.command || input.script || input.path || input.file_path || event.text;
  return clean(`${event.name || 'tool'} ${value}`).slice(0, 1200);
}

function resultSignature(event) {
  const text = clean(event && event.text).toLowerCase();
  const exit = text.match(/(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exit_code)[\s:=]+(-?\d+)/);
  if (event && event.isError) return `error:${text.slice(0, 500)}`;
  if (exit) return `${+exit[1] === 0 ? 'success' : 'failure'}:exit-${exit[1]}:${text.slice(0, 400)}`;
  if (/\[[^\]]+\s+[0-9a-f]{7,40}\]\s+/.test(text)) return `success:commit:${text.slice(0, 400)}`;
  if (/\b(?:failed|failure|error|fatal|exception|timed out)\b/.test(text)) return `failure:${text.slice(0, 500)}`;
  if (/\b(?:tests?|specs?)\b.{0,80}\b(?:passed|passing|ok)\b|\b(?:passed|passing)\b.{0,80}\b(?:tests?|specs?)\b/.test(text)) return `success:test:${text.slice(0, 400)}`;
  return `recorded:${text.slice(0, 500)}`;
}

function operationOf(event) {
  if (!event || event.kind !== 'tool') return 'other';
  const name = String(event.name || '').toLowerCase();
  const command = commandOf(event).toLowerCase();
  if (/apply_patch|write|edit|replace|create_file/.test(name)
      || /\b(?:sed\s+-i|perl\s+-[^ ]*i|tee|cp|mv)\b/.test(command)) return 'change';
  if (/\b(?:test|vitest|jest|pytest|cargo test|go test|pnpm test|npm test|yarn test|typecheck|lint)\b/.test(command)) return 'validation';
  if (/\bgit\s+commit\b/.test(command)) return 'commit';
  if (/\bgit\s+(?:merge|rebase)\b/.test(command)) return 'integration';
  if (/\b(?:deploy|release|publish)\b/.test(command)) return 'delivery';
  return 'other';
}

function pathsOf(event) {
  if (!event || event.kind !== 'tool') return [];
  const input = inputOf(event), values = [];
  for (const key of ['path', 'file', 'file_path', 'target', 'destination']) if (typeof input[key] === 'string') values.push(input[key]);
  if (Array.isArray(input.paths)) values.push(...input.paths.filter(value => typeof value === 'string'));
  const patch = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input
    : /apply_patch/i.test(event.name || '') ? String(event.text || '') : '';
  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) values.push(match[1]);
  }
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 100);
}

function isCompletionClaim(event) {
  if (!event || event.kind !== 'agent') return false;
  const text = String(event.text || '');
  if (/^\s*(?:<system-reminder>|(?:sessionstart|stop) hook\b)/i.test(text)) return false;
  return text.split('\n').some(value => {
    const line = value.trim().replace(/^(?:[-*#]+|\d+[.)])\s*/, '').toLowerCase();
    if (/\b(?:not done|not finished|not complete|still need|remaining|blocked)\b/.test(line)) return false;
    return /^(?:(?:i(?:'ve| have)?\s+)?(?:implemented|completed|finished|fixed|resolved)\b|done[.!:]|(?:the\s+)?(?:implementation|fix|work|task)\s+is\s+(?:complete|ready)\b|tests?\s+(?:now\s+)?pass(?:ed|ing)?\b)/.test(line);
  });
}

function evidence(event, session) {
  return { id: event.id, session: session.key, kind: event.kind, name: event.name || null,
    ts: event.ts || null, text: clean(event.text).slice(0, 220) };
}

function finding(rule, session, events, details) {
  const times = events.map(at).filter(Number.isFinite);
  return {
    id: hash(`${rule}:${session.key}:${details.command || details.title || ''}`), rule,
    repo: session.repo || 'Unknown repository', cwd: session.cwd || '', session: session.key,
    sessionId: session.id || null, title: session.title || session.id || 'Untitled session',
    from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null,
    evidence: events.slice(0, 12).map(event => evidence(event, session)), evidenceCount: events.length,
    ...details,
  };
}

function analyzeSession(session, events, now = Date.now(), coverage = {}) {
  const ordered = events.slice().sort((a, b) => (at(a) || 0) - (at(b) || 0));
  const calls = new Map(), pairs = [], findings = [], changes = [], validations = [], commits = [], integrations = [], deliveries = [], claims = [];
  for (const event of ordered) {
    if (event.kind === 'tool' && event.callId) calls.set(event.callId, event);
    if (event.kind === 'result' && event.callId && calls.has(event.callId)) pairs.push({ call: calls.get(event.callId), result: event });
    if (event.kind === 'tool') {
      const operation = operationOf(event);
      if (operation === 'change') changes.push(event);
      if (operation === 'commit') commits.push(event);
      if (operation === 'integration') integrations.push(event);
      if (operation === 'delivery') deliveries.push(event);
    }
    if (isCompletionClaim(event)) claims.push(event);
  }
  const pairedCalls = new Set(pairs.map(pair => pair.call.id));
  const grouped = new Map();
  for (const pair of pairs) {
    const command = commandOf(pair.call);
    if (!command) continue;
    const signature = resultSignature(pair.result);
    const key = `${command.toLowerCase()}\n${signature}`;
    if (!grouped.has(key)) grouped.set(key, { command, signature, pairs: [] });
    grouped.get(key).pairs.push(pair);
    if (operationOf(pair.call) === 'validation') {
      validations.push({ call: pair.call, result: pair.result, command,
        outcome: signature.startsWith('success:') ? 'passed' : signature.startsWith('failure:') ? 'failed' : 'recorded-result' });
    }
  }
  for (const group of grouped.values()) {
    const records = group.pairs.flatMap(pair => [pair.call, pair.result]);
    if (group.pairs.length >= 2 && group.signature.startsWith('failure:')) findings.push(finding('repeated-failure', session, records, {
      severity: 'high', title: 'Equivalent failure repeated', trigger: `${group.pairs.length} equivalent command/result pairs`,
      rationale: 'The same recorded command produced an equivalent failure more than once.',
      uncertainty: 'Equivalent normalized text does not prove the attempts had identical external state.', command: group.command,
    }));
    else if (group.pairs.length >= 3) findings.push(finding('repeated-command', session, records, {
      severity: 'low', title: 'Equivalent command and result repeated', trigger: `${group.pairs.length} equivalent command/result pairs`,
      rationale: 'Repeated equivalent evidence may be intentional polling or may be worth reviewing.',
      uncertainty: 'Repetition alone is not a defect; inputs outside the recorded command may have changed.', command: group.command,
    }));
  }
  for (const call of calls.values()) {
    const started = at(call);
    if (!pairedCalls.has(call.id) && started != null && now - started >= 2 * 60000) findings.push(finding('long-wait', session, [call], {
      severity: now - started >= 10 * 60000 ? 'high' : 'medium', title: 'Recorded call still has no result',
      trigger: `${Math.floor((now - started) / 60000)} minutes since the recorded call`,
      rationale: 'An identifiable tool call has no paired result in the committed local index.',
      uncertainty: 'The source may be incomplete, delayed, or may never record a matching result.', command: commandOf(call),
    }));
  }
  for (const claim of claims) {
    const claimAt = at(claim);
    const before = validations.filter(item => item.outcome === 'passed' && (at(item.result) || -Infinity) <= (claimAt == null ? Infinity : claimAt));
    const latest = before.at(-1);
    const laterChange = latest && changes.find(change => (at(change) || -Infinity) > (at(latest.result) || Infinity));
    if (!latest || laterChange) findings.push(finding('stale-verification', session, [claim, ...(latest ? [latest.call, latest.result] : []), ...(laterChange ? [laterChange] : [])], {
      severity: 'medium', title: latest ? 'Completion-like claim follows historical validation' : 'Completion-like claim has no recorded validation',
      trigger: latest ? 'A relevant change was recorded after the latest validation result.' : 'No paired validation result was recorded before this claim.',
      rationale: latest ? 'The earlier validation remains evidence for an earlier recorded state, not the later change.' : 'A claim and observed validation are independent states.',
      uncertainty: 'Burnboard only evaluates recorded events and cannot prove what ran outside these logs.',
    }));
  }
  const last = ordered.at(-1), lastSeen = Math.max(session.mtime || 0, at(last) || 0) || null;
  const terminal = last && ['turn_aborted', 'session_end', 'result'].includes(last.originalType);
  const age = lastSeen == null ? Infinity : now - lastSeen;
  const state = terminal ? 'ended' : age <= 15000 ? 'running' : age <= 5 * 60000 ? 'idle' : 'unknown';
  return {
    session, events: ordered, findings, paths: changes.flatMap(event => pathsOf(event).map(file => ({ file, event }))), coverageTruncated: !!coverage.truncated,
    state, lastSeen,
    trail: {
      request: ordered.find(event => event.kind === 'human') || null,
      claims, changes, validations, commits, integrations, deliveries,
      commands: pairs.map(pair => ({ ...pair, command: commandOf(pair.call), outcome: resultSignature(pair.result).startsWith('success:') ? 'succeeded'
        : resultSignature(pair.result).startsWith('failure:') || resultSignature(pair.result).startsWith('error:') ? 'failed' : 'recorded-result' })),
      coverage: `Recorded and deterministically inferred local evidence only. Current filesystem state was not used as historical proof.${coverage.truncated ? ` Analysis used the newest ${MAX_EVENTS_PER_SESSION.toLocaleString()} events plus the first recorded request.` : ''}`,
    },
  };
}

function worktreeKind(cwd) {
  if (!cwd) return { kind: 'unknown', reason: 'Working directory was not recorded.' };
  if (/(?:^|[\\/])(?:\.worktrees?|worktrees?)(?:[\\/]|$)/i.test(cwd)) return { kind: 'worktree-shaped', reason: 'Path shape suggests a worktree; Git registration was not checked.' };
  return { kind: 'primary-or-nested', reason: 'Recorded working directory; primary checkout status is not proven.' };
}

function publicTrail(analysis) {
  const map = event => event && evidence(event, analysis.session);
  const recent = values => values.slice(-MAX_TRAIL_ITEMS);
  const omitted = values => Math.max(0, values.length - MAX_TRAIL_ITEMS);
  return {
    session: analysis.session, state: analysis.state, lastSeen: analysis.lastSeen,
    request: map(analysis.trail.request), claims: recent(analysis.trail.claims).map(map), changes: recent(analysis.trail.changes).map(map),
    commands: recent(analysis.trail.commands).map(item => ({ command: item.command, outcome: item.outcome, call: map(item.call), result: map(item.result) })),
    validations: recent(analysis.trail.validations).map(item => ({ command: item.command, outcome: item.outcome,
      call: map(item.call), result: map(item.result), historical: analysis.trail.changes.some(change => (at(change) || -Infinity) > (at(item.result) || Infinity)),
      scope: pathsOf(item.call).join(', ') || (analysis.session.cwd ? `Recorded working directory: ${analysis.session.cwd}` : 'Not recorded'),
      revision: null, workState: 'Not recorded' })),
    commits: recent(analysis.trail.commits).map(map), integrations: recent(analysis.trail.integrations).map(map), deliveries: recent(analysis.trail.deliveries).map(map),
    coverage: `${analysis.trail.coverage} Trail categories return at most the newest ${MAX_TRAIL_ITEMS.toLocaleString()} records.`,
    omitted: { claims: omitted(analysis.trail.claims), changes: omitted(analysis.trail.changes), commands: omitted(analysis.trail.commands),
      validations: omitted(analysis.trail.validations), commits: omitted(analysis.trail.commits), integrations: omitted(analysis.trail.integrations), deliveries: omitted(analysis.trail.deliveries) },
  };
}

function createFlightRecorder({ investigation, now = () => Date.now() }) {
  let cachedRevision = -1, cache = [], availableSessions = 0;
  async function analyses() {
    const revision = investigation.status().revision;
    if (revision === cachedRevision) return cache;
    const next = [], sessions = investigation.sessions();
    availableSessions = sessions.length;
    for (const session of sessions.slice(0, MAX_SESSIONS)) {
      const events = []; let firstRequest = null, truncated = false;
      for await (const event of investigation.sessionEvents(session.key)) {
        if (!firstRequest && event.kind === 'human') firstRequest = event;
        events.push(event);
        if (events.length > MAX_EVENTS_PER_SESSION + 500) { events.splice(0, 500); truncated = true; }
      }
      if (events.length > MAX_EVENTS_PER_SESSION) { events.splice(0, events.length - MAX_EVENTS_PER_SESSION); truncated = true; }
      if (firstRequest && !events.some(event => event.id === firstRequest.id)) events.unshift(firstRequest);
      next.push(analyzeSession(session, events, now(), { truncated }));
    }
    cache = next; cachedRevision = revision;
    return cache;
  }
  async function overview(query = {}) {
    const since = Number(query.since) || 0;
    const ruleValue = Object.hasOwn(query, 'rules') ? query.rules : RULES.join(',');
    const enabled = new Set(String(ruleValue).split(',').filter(rule => RULES.includes(rule)));
    const all = await analyses();
    const selected = all.filter(item => !query.repo || `${item.session.repo || ''} ${item.session.cwd || ''}`.toLowerCase().includes(String(query.repo).toLowerCase()));
    const findings = selected.flatMap(item => item.findings).filter(item => enabled.has(item.rule) && (!since || item.to == null || item.to >= since));
    const children = new Map(selected.map(item => [item.session.id, item]));
    for (const item of selected) {
      if (!item.session.parentId) continue;
      const parent = children.get(item.session.parentId);
      if (!parent) continue;
      const childEnd = item.session.maxTime || item.lastSeen;
      const acknowledged = parent.events.some(event => at(event) != null && childEnd != null && at(event) > childEnd);
      if (!acknowledged && enabled.has('unacknowledged-child') && (!since || childEnd == null || childEnd >= since)) findings.push(finding('unacknowledged-child', item.session, item.events.slice(-1), {
        severity: 'low', title: 'Child result has no recorded parent acknowledgement', trigger: 'Explicit parent/child identifiers are present.',
        rationale: 'No acknowledgement recorded in the parent after the child\'s last recorded event.',
        uncertainty: 'The parent may have acknowledged the result outside the indexed records.', parentSession: parent.session.key,
      }));
    }
    const lanes = new Map();
    for (const item of selected) {
      const repo = item.session.repo || 'Unknown repository', cwd = item.session.cwd || 'Working directory not recorded';
      const key = `${repo}\n${cwd}`;
      if (!lanes.has(key)) lanes.set(key, { repo, cwd, label: cwd === 'Working directory not recorded' ? cwd : path.basename(cwd), ...worktreeKind(item.session.cwd), sessions: [] });
      const parent = item.session.parentId && children.get(item.session.parentId);
      const timing = !parent || item.session.minTime == null || item.session.maxTime == null || parent.session.minTime == null || parent.session.maxTime == null
        ? 'unclassified' : item.session.minTime <= parent.session.maxTime && parent.session.minTime <= item.session.maxTime ? 'parallel' : 'sequential';
      lanes.get(key).sessions.push({ key: item.session.key, id: item.session.id, parentId: item.session.parentId,
        title: item.session.title, source: item.session.source, state: item.state, lastSeen: item.lastSeen,
        minTime: item.session.minTime, maxTime: item.session.maxTime, explicitRelationship: !!item.session.parentId, timing });
    }
    const pathGroups = new Map();
    for (const item of selected) for (const entry of item.paths) {
      const normalized = path.normalize(entry.file);
      const relative = path.isAbsolute(normalized) && item.session.cwd
        ? path.relative(path.normalize(item.session.cwd), normalized) : normalized;
      const key = relative && !relative.startsWith('..') ? relative : normalized;
      if (!pathGroups.has(key)) pathGroups.set(key, []);
      pathGroups.get(key).push({ item, entry });
    }
    const overlaps = []; let overlapCount = 0;
    for (const [file, records] of pathGroups) {
      const sessions = [...new Map(records.map(record => [record.item.session.key, record.item])).values()];
      for (let i = 0; i < sessions.length; i++) for (let j = i + 1; j < sessions.length; j++) {
        const a = sessions[i], b = sessions[j];
        const intersects = (a.session.minTime || 0) <= (b.session.maxTime || Infinity) && (b.session.minTime || 0) <= (a.session.maxTime || Infinity);
        if (intersects) {
          overlapCount++;
          if (overlaps.length < MAX_OVERLAPS) overlaps.push({ id: hash(`${file}:${a.session.key}:${b.session.key}`), file,
            label: 'Observed edit overlap; not proof of a merge conflict.', sessions: [a.session.key, b.session.key],
            evidence: records.filter(record => record.item === a || record.item === b).slice(0, 8).map(record => evidence(record.entry.event, record.item.session)) });
        }
      }
    }
    const brief = [...lanes.values()].map(lane => ({ repo: lane.repo, cwd: lane.cwd,
      sessions: lane.sessions.filter(session => !since || (session.lastSeen || 0) >= since).length,
      findings: findings.filter(item => item.repo === lane.repo && item.cwd === (lane.cwd === 'Working directory not recorded' ? '' : lane.cwd)).length }))
      .filter(row => row.sessions || row.findings);
    const sortedFindings = findings.sort((a, b) => (b.to || 0) - (a.to || 0));
    return { revision: investigation.status().revision, generatedAt: now(), since, rules: RULES,
      coverage: { availableSessions, analyzedSessions: all.length, maxSessions: MAX_SESSIONS,
        maxEventsPerSession: MAX_EVENTS_PER_SESSION, truncatedSessions: all.filter(item => item.coverageTruncated).length,
        matchedFindings: sortedFindings.length, returnedFindings: Math.min(sortedFindings.length, MAX_FINDINGS), maxFindings: MAX_FINDINGS,
        matchedOverlaps: overlapCount, returnedOverlaps: overlaps.length, maxOverlaps: MAX_OVERLAPS },
      brief, findings: sortedFindings.slice(0, MAX_FINDINGS), lanes: [...lanes.values()], overlaps };
  }
  async function session(key) {
    const item = (await analyses()).find(value => value.session.key === key);
    return item ? publicTrail(item) : null;
  }
  return { overview, session };
}

module.exports = { createFlightRecorder, analyzeSession, commandOf, resultSignature, operationOf, pathsOf, isCompletionClaim, RULES };
