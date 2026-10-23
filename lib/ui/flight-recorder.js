(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BurnboardFlightRecorder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE = 'burnboard.flight-recorder.v1';
  const Progress = () => typeof require === 'function' && typeof module === 'object' ? require('./progress') : globalThis.BurnboardProgress;
  const Activity = () => typeof require === 'function' && typeof module === 'object' ? require('./spin-activity') : globalThis.BurnboardSpinActivity;
  const OPEN_STATES = ['active', 'idle', 'abandoned'];
  // A spin card's kicker: the server's label, re-derived from the recorded last
  // activity and the current time so "active" turns into "idle since HH:MM"
  // (and later "abandoned") while the page stays open.
  function spinOutcome(finding, now = Date.now()) {
    const s = finding.spin || {}, a = s.activity, lib = Activity();
    if (!lib || !a || !OPEN_STATES.includes(a.state)) return s.outcome || '';
    return lib.describe({ end: null, callouts: s.callouts, merged: s.merged }, { now, at: a.lastActivity, settings: a }).label;
  }
  // Changes in this signature (a new episode, or a thread going active / idle
  // / abandoned) make the open Brief refetch its findings.
  const summarySignature = summary => (summary.items || []).map(item => `${item.id}:${item.level}:${(item.activity && item.activity.state) || item.outcome || ''}`).sort().join('|');
  const RULE_LABELS = {
    spin: 'Spin watch (churning agents)',
    'repeated-failure': 'Repeated failures', 'repeated-command': 'Repeated command/results',
    'long-wait': 'Long waits', 'stale-verification': 'Stale or missing verification',
    'unacknowledged-child': 'Unacknowledged child results',
  };
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const clock = value => value == null || !Number.isFinite(+value) ? 'Time not recorded' : new Date(+value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ago = value => {
    if (value == null) return 'last seen not recorded';
    const minutes = Math.max(0, Math.round((Date.now() - value) / 60000));
    return minutes < 1 ? 'seen just now' : minutes < 60 ? `seen ${minutes}m ago` : `seen ${Math.round(minutes / 60)}h ago`;
  };
  function readState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch (_) {}
    return { acknowledged: {}, dismissed: {}, snoozed: {}, disabledRules: [], lastVisit: null, range: 'last', collapsed: {}, ...saved };
  }
  function saveState(state) {
    try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch (_) {}
  }
  function investigationUrl(finding, evidence = finding.evidence && finding.evidence[0]) {
    const params = { session: evidence && evidence.session || finding.session };
    if (evidence && evidence.id) params.event = evidence.id;
    if (finding.from != null) params.from = finding.from;
    if (finding.to != null) params.to = Math.max(finding.from + 1, finding.to);
    return '#investigate?' + new URLSearchParams(params);
  }
  function severityRank(value) { return { high: 3, medium: 2, low: 1 }[value] || 0; }
  // Spin findings sort first: they are the one card per session that the
  // session's other findings nest under.
  function findingOrder(a, b) {
    return (b.rule === 'spin') - (a.rule === 'spin') || severityRank(b.severity) - severityRank(a.severity) || (b.to || 0) - (a.to || 0);
  }
  const focusFromHash = hash => /[?&]attention=spin\b/.test(String(hash || '')) ? 'spin' : null;
  function sparkline(history) {
    const points = (history || []).filter(item => Array.isArray(item) && Number.isFinite(+item[1]));
    if (points.length < 2) return '';
    const w = 180, h = 32, t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
    const x = t => ((t - t0) / Math.max(1, t1 - t0)) * w, y = v => h - Math.max(0, Math.min(1, v)) * h;
    const line = points.map(item => `${x(item[0]).toFixed(1)},${y(+item[1]).toFixed(1)}`).join(' ');
    return `<svg class="fr-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Spin score history"><line x1="0" x2="${w}" y1="${y(0.85)}" y2="${y(0.85)}" class="alert"/><line x1="0" x2="${w}" y1="${y(0.7)}" y2="${y(0.7)}" class="watch"/><polyline points="${line}"/></svg>`;
  }
  function mount(attentionRoot, boardRoot, options = {}) {
    const state = readState(), openedAt = Date.now();
    const previousVisit = state.lastVisit || openedAt - 8 * 3600000;
    let overview = null, busy = false, queued = false, showAll = false, focusRule = focusFromHash(typeof location !== 'undefined' ? location.hash : '');
    const settingsHost = typeof document !== 'undefined' ? document.createElement('div') : null;
    if (settingsHost) { settingsHost.className = 'fr-spin-settings'; settingsHost.innerHTML = '<p>Loading spin watch settings…</p>'; }
    const enabledRules = () => Object.keys(RULE_LABELS).filter(rule => !state.disabledRules.includes(rule));
    const since = () => state.range === 'last' ? previousVisit : openedAt - Number(state.range || 8) * 3600000;
    // Until the first Brief renders, both panels show live progress.
    const progressUI = Progress();
    let loader = progressUI && (attentionRoot || boardRoot) ? progressUI.createLoader([attentionRoot, boardRoot], { title: 'Building your attention brief', intervalMs: options.progressIntervalMs || 1000 }) : null;
    async function load(refresh = true) {
      if (busy) { queued = true; return; }
      busy = true;
      if (loader && !overview && !loader.active) loader.start();
      try {
        const archive = state.range === 'archive';
        const params = new URLSearchParams({ since: archive ? '0' : String(since()), rules: enabledRules().join(','), ...(archive ? { archive: '1' } : {}), ...(refresh ? {} : { refresh: '0' }) });
        const response = await fetch('/api/flight/overview?' + params);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Release Two analysis failed');
        if (loader) { loader.stop(); loader = null; }
        overview = result; render();
      } catch (error) {
        const message = `The attention brief could not be built: ${error.message}`;
        if (loader && !overview) loader.fail(message);
        else {
          if (attentionRoot) attentionRoot.innerHTML = `<div class="fr-error">${escape(message)}</div>`;
          if (boardRoot) boardRoot.innerHTML = `<div class="fr-error">${escape(message)}</div>`;
        }
      } finally {
        busy = false;
        if (queued) { queued = false; load(); }
      }
    }
    function findingState(finding) {
      if (state.dismissed[finding.id]) return 'dismissed';
      if (state.snoozed[finding.id] > Date.now()) return 'snoozed';
      if (state.acknowledged[finding.id]) return 'acknowledged';
      return 'open';
    }
    // The thread name leads a spin card. Untitled threads fall back to a short
    // session id so the heading is never empty.
    function threadName(finding) {
      const id = String(finding.sessionId || finding.session || '');
      const title = String(finding.sessionTitle || '').trim();
      if (title && title !== id) return title;
      return id ? `Session ${id.slice(0, 13)}` : 'Untitled session';
    }
    function renderSpin(finding, status) {
      const s = finding.spin || {};
      const supporting = (finding.supporting || []).filter(item => !['dismissed', 'snoozed'].includes(findingState(item))).sort(findingOrder);
      const trail = s.trail || [];
      const deleted = s.transcriptDeleted;
      return `<article class="fr-finding fr-spin severity-${escape(finding.severity)}${status === 'acknowledged' ? ' is-acknowledged' : ''}" data-finding="${escape(finding.id)}">
        <div class="fr-finding-top"><span class="fr-severity">${escape(s.level || finding.severity)}</span><span class="fr-rule">${escape(RULE_LABELS.spin)}</span><span class="fr-outcome" data-fr-outcome="${escape(finding.id)}">${escape(spinOutcome(finding))}</span><time>${escape(clock(finding.to))}</time></div>
        <h3 class="fr-spin-thread">${escape(threadName(finding))}</h3>
        <p class="fr-spin-session">${escape(s.source === 'claude' ? 'Claude Code' : 'Codex')}${finding.repo ? ` · ${escape(finding.repo)}` : ''}${s.isRoot === false ? ` · helper agent${s.root ? ` of ${escape(String(s.root).slice(0, 13))}` : ''}` : ''}</p>
        <p class="fr-spin-reasons">${escape(finding.title)}</p>
        <p>${escape(finding.rationale)}</p>
        <div class="fr-spin-score">${sparkline(s.history)}<span>peak ${Number(s.peakScore || 0).toFixed(2)} · ${escape(s.peakLevel || '')}${s.otherEpisodes ? ` · ${s.otherEpisodes} earlier episode${s.otherEpisodes === 1 ? '' : 's'} in this interval` : ''}${s.label ? ` · study label ${escape(s.label.label)}` : ''}</span></div>
        ${deleted ? `<p class="fr-spin-deleted">The transcript was deleted (Claude Code removes transcripts after about 30 days). This card shows the archived evidence trail and score history${s.earlierScorer ? ', scored by an earlier version of spin watch and kept as it was' : ''}.</p>` : ''}
        ${s.rescorePending ? '<p class="fr-spin-version">Scored by an earlier version of spin watch. A rescore is pending.</p>' : ''}
        ${(s.callouts || []).length ? `<p class="fr-spin-callout">You called it out: “${escape(s.callouts[0].text)}”</p>` : ''}
        <details><summary>${trail.length.toLocaleString()} archived action${trail.length === 1 ? '' : 's'} · ${escape(finding.trigger)}</summary>
          <p><b>Uncertainty:</b> ${escape(finding.uncertainty)}</p>
          <table class="fr-trail"><thead><tr><th>Time</th><th>Op</th><th>Command or file</th><th>Outcome</th></tr></thead><tbody>${trail.slice().reverse().map(item => `<tr${item.ceremony ? ' class="ceremony"' : ''}><td>${escape(clock(item.t))}</td><td>${escape(item.op)}</td><td><code>${escape(item.cmd || item.file || '')}</code></td><td>${escape(item.err || item.outcome || '')}</td></tr>`).join('')}</tbody></table>
          ${(s.humans || []).length ? `<h4>Nearby human messages</h4><ol>${s.humans.map(item => `<li>${escape(clock(item.t))} · ${escape(item.who || 'user')}: ${escape(item.text)}</li>`).join('')}</ol>` : ''}</details>
        ${supporting.length ? `<details class="fr-supporting"><summary>${supporting.length} supporting finding${supporting.length === 1 ? '' : 's'} from other rules in the same session</summary>${supporting.map(item => renderFinding(item, true)).join('')}</details>` : ''}
        <div class="fr-actions">${deleted ? '<span class="fr-primary fr-disabled" title="Transcript deleted">Evidence archived</span>' : `<a class="fr-primary" href="${investigationUrl(finding)}">Investigate evidence</a>`}
          <button type="button" data-fr="ack" data-id="${escape(finding.id)}">${status === 'acknowledged' ? 'Unacknowledge' : 'Acknowledge'}</button>
          <button type="button" data-fr="snooze" data-id="${escape(finding.id)}">Snooze 1h</button>
          <button type="button" data-fr="dismiss" data-id="${escape(finding.id)}">Dismiss</button></div></article>`;
    }
    function renderFinding(finding, nested = false) {
      const status = findingState(finding);
      if (status === 'dismissed' || status === 'snoozed') return '';
      if (finding.rule === 'spin' && !nested) return renderSpin(finding, status);
      return `<article class="fr-finding severity-${escape(finding.severity)}${status === 'acknowledged' ? ' is-acknowledged' : ''}" data-finding="${escape(finding.id)}">
        <div class="fr-finding-top"><span class="fr-severity">${escape(finding.severity)}</span><span class="fr-rule">${escape(RULE_LABELS[finding.rule] || finding.rule)}</span><time>${escape(clock(finding.to))}</time></div>
        <h3>${escape(finding.title)}</h3><p>${escape(finding.rationale)}</p>
        <details><summary>${finding.evidenceCount.toLocaleString()} supporting event${finding.evidenceCount === 1 ? '' : 's'} · ${escape(finding.trigger)}</summary>
          <p><b>Uncertainty:</b> ${escape(finding.uncertainty)}</p>${finding.command ? `<code>${escape(finding.command)}</code>` : ''}
          <ol>${(finding.evidence || []).map(item => `<li><a href="${investigationUrl(finding, item)}">${escape(item.kind)} · ${escape(clock(Date.parse(item.ts)))}</a> ${escape(item.text)}</li>`).join('')}</ol></details>
        <div class="fr-actions"><a class="fr-primary" href="${investigationUrl(finding)}">Investigate evidence</a>
          <button type="button" data-fr="ack" data-id="${escape(finding.id)}">${status === 'acknowledged' ? 'Unacknowledge' : 'Acknowledge'}</button>
          <button type="button" data-fr="snooze" data-id="${escape(finding.id)}">Snooze 1h</button>
          <button type="button" data-fr="dismiss" data-id="${escape(finding.id)}">Dismiss</button></div></article>`;
    }
    // Threads scored by an earlier scorer version: say so briefly, offer one
    // explicit background rescore, and show its progress while it runs.
    let rescoreLoader = null;
    function rescoreNote(versions) {
      if (!versions) return '';
      if (versions.rescore && versions.rescore.running) return '<div class="fr-spin-pending" data-fr-slot="rescore"></div>';
      if (!versions.pendingThreads) return '';
      const n = versions.pendingThreads;
      return `<div class="fr-spin-pending"><p>Spin watch scoring changed since ${n.toLocaleString()} thread${n === 1 ? ' was' : 's were'} scored. Their cards show the earlier scores until they are rescored.</p><button type="button" data-fr="rescore">Rescore now</button></div>`;
    }
    function watchRescore(versions) {
      if (rescoreLoader) { rescoreLoader.stop(); rescoreLoader = null; }
      const host = attentionRoot.querySelector && attentionRoot.querySelector('[data-fr-slot="rescore"]');
      const ui = Progress();
      if (!host || !ui || !(versions && versions.rescore && versions.rescore.running)) return;
      rescoreLoader = ui.createLoader(host, { url: '/api/spin/rescore', intervalMs: options.progressIntervalMs || 1000, title: 'Spin watch',
        onProgress: body => { if (body.phase !== 'rescore') { rescoreLoader = null; load(false); return false; } return true; } });
      rescoreLoader.start();
    }
    async function startRescore() {
      try {
        const response = await fetch('/api/spin/rescore', { method: 'POST' });
        const result = await response.json();
        if (!response.ok && response.status !== 409) throw new Error(result.error || 'Rescore could not start');
        setTimeout(() => load(false), 500);
      } catch (error) {
        const slot = attentionRoot.querySelector('.fr-spin-pending'); if (slot) slot.innerHTML = `<p class="fr-error">${escape(error.message)}</p>`;
      }
    }
    function renderAttention() {
      if (!attentionRoot || !overview) return;
      const x = window.scrollX, y = window.scrollY;
      const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-fr]');
      const focus = focused && { action: focused.dataset.fr, id: focused.dataset.id };
      const opened = new Set([...attentionRoot.querySelectorAll('.fr-finding details[open]')].map(details => details.closest('.fr-finding').dataset.finding));
      const controlsOpen = !!attentionRoot.querySelector('.fr-controls > details[open]');
      const findings = overview.findings.slice().sort(findingOrder);
      const visible = findings.filter(finding => !['dismissed', 'snoozed'].includes(findingState(finding)) && (!focusRule || finding.rule === focusRule));
      const archive = state.range === 'archive';
      const spinCoverage = overview.spinCoverage;
      const shown = showAll ? visible : visible.slice(0, 12);
      const coverage = overview.coverage || {};
      const coverageText = coverage.availableSessions > coverage.analyzedSessions ? `Newest ${coverage.analyzedSessions.toLocaleString()} of ${coverage.availableSessions.toLocaleString()} indexed sessions analyzed.` : `${(coverage.analyzedSessions || 0).toLocaleString()} indexed sessions analyzed.`;
      const omittedText = coverage.matchedFindings > coverage.returnedFindings ? ` Showing ${coverage.returnedFindings.toLocaleString()} of ${coverage.matchedFindings.toLocaleString()} matched findings.` : '';
      const spinText = spinCoverage ? ` Spin watch findings come from its episode archive (${spinCoverage.findings.toLocaleString()} here) and are not limited by these caps.` : '';
      attentionRoot.innerHTML = `<section class="fr-attention"><div class="fr-heading"><div><span class="fr-eyebrow">Release Two · deterministic local signals</span><h2>Attention brief</h2><p>${visible.length ? `${visible.length} recorded pattern${visible.length === 1 ? '' : 's'} worth a look.` : focusRule ? 'No spin watch episode in this interval.' : 'No enabled attention rule fired in this interval.'} Nothing here stops or reruns an agent.</p>${focusRule ? '<p class="fr-focus">Showing spin watch only. <button type="button" data-fr="unfocus">Show all rules</button></p>' : ''}${archive ? '<p class="fr-focus">All time (archived): every spin watch episode in the archive, including sessions whose transcripts are gone. Other rules need the live index and are not shown here.</p>' : ''}<p class="fr-coverage">${archive ? '' : escape(coverageText)}${!archive && coverage.truncatedSessions ? ` ${coverage.truncatedSessions.toLocaleString()} session${coverage.truncatedSessions === 1 ? '' : 's'} used the newest ${coverage.maxEventsPerSession.toLocaleString()} events plus the first request.` : ''}${escape(spinText)}</p></div>
        <div class="fr-controls"><label>Since<select data-fr="range"><option value="last"${state.range === 'last' ? ' selected' : ''}>Last visit · ${escape(clock(previousVisit))}</option>${[1, 8, 24, 72].map(hours => `<option value="${hours}"${String(state.range) === String(hours) ? ' selected' : ''}>Last ${hours}h</option>`).join('')}<option value="archive"${archive ? ' selected' : ''}>All time (archived)</option></select></label>
        <details><summary>Rule controls</summary>${Object.entries(RULE_LABELS).map(([rule, label]) => `<label><input type="checkbox" data-fr="rule" value="${rule}"${state.disabledRules.includes(rule) ? '' : ' checked'}> ${escape(label)}</label>`).join('')}<div data-fr-slot="spin-settings"></div></details></div></div>
        ${rescoreNote(spinCoverage && spinCoverage.versions)}
        <div class="fr-brief">${overview.brief.map(row => `<div><strong>${escape(row.repo)}</strong><span title="${escape(row.cwd)}">${escape(row.cwd || 'Worktree not recorded')}</span><b>${row.sessions} session${row.sessions === 1 ? '' : 's'} · ${row.findings} finding${row.findings === 1 ? '' : 's'}</b></div>`).join('') || '<p>No recorded activity in this interval.</p>'}</div>
        <div class="fr-findings">${shown.map(finding => renderFinding(finding)).join('') || '<div class="fr-clear">All clear for the enabled rules and interval. Unknown or incomplete records remain visible in Investigate source health.</div>'}</div>
        ${visible.length > 12 ? `<button class="fr-more" type="button" data-fr="show-all">${showAll ? 'Show highest-priority 12' : `Show all ${visible.length.toLocaleString()} findings`}</button>` : ''}</section>`;
      const coverageNode = attentionRoot.querySelector('.fr-coverage'); if (coverageNode && !archive) coverageNode.append(omittedText);
      watchRescore(spinCoverage && spinCoverage.versions);
      const slot = attentionRoot.querySelector('[data-fr-slot="spin-settings"]'); if (slot && settingsHost) slot.replaceWith(settingsHost);
      if (controlsOpen) { const controls = attentionRoot.querySelector('.fr-controls > details'); if (controls) controls.open = true; }
      for (const id of opened) {
        const details = attentionRoot.querySelector(`[data-finding="${CSS.escape(id)}"] details`); if (details) details.open = true;
      }
      requestAnimationFrame(() => {
        window.scrollTo(x, y);
        if (focus) attentionRoot.querySelector(`[data-fr="${CSS.escape(focus.action)}"]${focus.id ? `[data-id="${CSS.escape(focus.id)}"]` : ''}`)?.focus({ preventScroll: true });
      });
    }
    function relationship(session, lanes) {
      if (session.parentId) {
        const parent = lanes.flatMap(lane => lane.sessions).find(item => item.id === session.parentId);
        return parent ? `Explicit child of ${escape(parent.title || parent.id)} · ${escape(session.timing)} recorded intervals` : `Explicit parent ID ${escape(session.parentId)} (parent not in this view) · ${escape(session.timing)} timing`;
      }
      return 'No explicit parent/child record; grouping is inferred only from repository and working directory.';
    }
    function renderBoard() {
      if (!boardRoot || !overview) return;
      const byRepo = new Map();
      for (const lane of overview.lanes) {
        if (!byRepo.has(lane.repo)) byRepo.set(lane.repo, []);
        byRepo.get(lane.repo).push(lane);
      }
      boardRoot.innerHTML = `<div class="fr-board-heading"><div><span class="fr-eyebrow">Coordination without the graph tangle</span><h2>Worktree board</h2><p>Recorded paths create lanes. Path shape is not proof of Git worktree registration.</p></div><button type="button" data-fr="refresh">Refresh evidence</button></div>
        <div class="fr-overlaps">${overview.overlaps.map(overlap => `<article><span>Observed overlap</span><code>${escape(overlap.file)}</code><p>${escape(overlap.label)}</p><div>${overlap.evidence.map(item => `<a href="#investigate?${new URLSearchParams({ session: item.session, event: item.id })}">${escape(item.kind)} · ${escape(clock(Date.parse(item.ts)))}</a>`).join('')}</div></article>`).join('') || '<p>No concurrent recorded edit overlap was detected in indexed sessions.</p>'}</div>
        <div class="fr-repos">${[...byRepo].map(([repo, lanes]) => `<details class="fr-repo" open><summary>${escape(repo)} <small>${lanes.length} lane${lanes.length === 1 ? '' : 's'}</small></summary>
          ${lanes.map(lane => `<details class="fr-lane"${state.collapsed[lane.cwd] ? '' : ' open'} data-lane="${escape(lane.cwd)}"><summary><b>${escape(lane.label)}</b><span class="fr-kind">${escape(lane.kind)}</span><small>${lane.sessions.length} session${lane.sessions.length === 1 ? '' : 's'}</small></summary>
            <p class="fr-path" title="${escape(lane.cwd)}"><code>${escape(lane.cwd)}</code><span>${escape(lane.reason)}</span></p>
            <div class="fr-sessions">${lane.sessions.map(session => `<a href="#investigate?${new URLSearchParams({ session: session.key })}" class="fr-session ${session.explicitRelationship ? 'fr-explicit' : 'fr-inferred'}"><i class="state-${escape(session.state)}"></i><strong>${escape(session.title || session.id || 'Untitled session')}</strong><span>${escape(session.source)} · ${escape(session.state)} · ${escape(ago(session.lastSeen))}</span><small>${relationship(session, overview.lanes)}</small></a>`).join('')}</div></details>`).join('')}</details>`).join('') || '<p>No indexed worktree lanes.</p>'}</div>`;
    }
    function render() {
      const x = window.scrollX, y = window.scrollY;
      renderAttention(); renderBoard();
      requestAnimationFrame(() => window.scrollTo(x, y));
    }
    function action(event) {
      const target = event.target.closest('[data-fr]'); if (!target) return;
      const action = target.dataset.fr, id = target.dataset.id;
      if (action === 'range') { state.range = target.value; saveState(state); return load(); }
      if (action === 'rule') {
        state.disabledRules = [...(target.checked ? new Set(state.disabledRules.filter(rule => rule !== target.value)) : new Set([...state.disabledRules, target.value]))];
        saveState(state); return load();
      }
      if (action === 'ack') { state.acknowledged[id] ? delete state.acknowledged[id] : state.acknowledged[id] = Date.now(); }
      if (action === 'dismiss') state.dismissed[id] = Date.now();
      if (action === 'snooze') state.snoozed[id] = Date.now() + 3600000;
      if (action === 'refresh') return load();
      if (action === 'rescore') { target.disabled = true; target.textContent = 'Starting…'; return startRescore(); }
      if (action === 'unfocus') { focusRule = null; if (/attention=spin/.test(location.hash)) history.replaceState(null, '', '#running'); return renderAttention(); }
      if (action === 'show-all') { showAll = !showAll; return renderAttention(); }
      saveState(state); render();
      window.dispatchEvent(new Event('burnboard:spin-state'));
    }
    if (attentionRoot) { attentionRoot.addEventListener('click', action); attentionRoot.addEventListener('change', action); }
    if (boardRoot) {
      boardRoot.addEventListener('click', action); boardRoot.addEventListener('toggle', event => {
        const lane = event.target.closest && event.target.closest('.fr-lane');
        if (lane && event.target === lane) { state.collapsed[lane.dataset.lane] = !lane.open; saveState(state); }
      }, true);
    }
    const live = () => load(false);
    window.addEventListener('burnboard:investigation-status', live);
    // Re-label open spin cards as time passes, without refetching.
    function relabel() {
      if (!attentionRoot || !overview || !attentionRoot.querySelectorAll) return;
      const byId = new Map(overview.findings.filter(item => item.rule === 'spin').map(item => [item.id, item]));
      for (const node of attentionRoot.querySelectorAll('[data-fr-outcome]')) {
        const finding = byId.get(node.dataset.frOutcome);
        const text = finding && spinOutcome(finding);
        if (text && node.textContent !== text) node.textContent = text;
      }
    }
    const ticker = setInterval(relabel, options.relabelIntervalMs || 30000);
    if (ticker && typeof ticker.unref === 'function') ticker.unref(); // tests under Node
    // The spin badge polls the summary; refetch when a thread's state changes.
    let lastSignature = null;
    const onSummary = event => {
      const signature = summarySignature((event && event.detail) || {});
      if (lastSignature != null && signature !== lastSignature) load(false);
      lastSignature = signature;
    };
    window.addEventListener('burnboard:spin-summary', onSummary);
    const onHash = () => {
      const next = focusFromHash(location.hash);
      if (next && next !== focusRule) { focusRule = next; renderAttention(); if (attentionRoot && attentionRoot.scrollIntoView) attentionRoot.scrollIntoView({ block: 'start' }); }
    };
    window.addEventListener('hashchange', onHash);
    if (settingsHost) mountSpinSettings(settingsHost);
    state.lastVisit = openedAt; saveState(state); load();
    return { load, relabel, destroy() { clearInterval(ticker); window.removeEventListener('burnboard:investigation-status', live); window.removeEventListener('burnboard:spin-summary', onSummary); window.removeEventListener('hashchange', onHash); } };
  }

  // Spin watch settings live beside the per-rule controls and are saved to
  // ~/.config/burnboard/spin.json through the loopback-only /api/spin/config.
  // The setup status (GET /api/spin/setup) is the same plain text the server
  // prints on start: copyable, read-only, no install button.
  const setupBlock = setup => `<pre class="fr-spin-setup" data-spin-setup${setup && typeof setup.text === 'string' ? '' : ' hidden'}>${setup && typeof setup.text === 'string' ? escape(setup.text) : ''}</pre>`;
  function settingsForm(config, info = {}, setup = null) {
    const c = config, sel = (name, value, options) => `<select data-spin="${name}">${options.map(([v, label]) => `<option value="${v}"${String(value) === String(v) ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>`;
    const num = (name, value, step, min, max) => `<input type="number" data-spin="${name}" value="${value == null ? '' : escape(value)}" step="${step}" min="${min}" max="${max}">`;
    const archive = info.archive || {};
    const hooks = info.hookInstalled || {};
    return `<form class="fr-spin-form" data-spin-form>
      <h4>Spin watch settings</h4>
      ${setupBlock(setup)}
      <label><input type="checkbox" data-spin="enabled"${c.enabled ? ' checked' : ''}> Spin watch sensor enabled</label>
      <fieldset><legend>Desktop notifications</legend>
        <label><input type="checkbox" data-spin="desktop.enabled"${c.desktop.enabled ? ' checked' : ''}> Show a Windows toast</label>
        <label>At ${sel('desktop.minLevel', c.desktop.minLevel, [['alert', 'alert only'], ['watch', 'watch or alert']])}</label>
        <label>Per-session cooldown (minutes) ${num('desktop.cooldownMinutes', c.desktop.cooldownMinutes, 1, 0, 10080)}</label></fieldset>
      <fieldset><legend>Agent nudge</legend>
        <label>Mode ${sel('agentNudge.mode', c.agentNudge.mode, [['off', 'off'], ['shadow', 'shadow (log only)'], ['nudge', 'nudge the agent']])}</label>
        <label>At ${sel('agentNudge.minLevel', c.agentNudge.minLevel, [['alert', 'alert only'], ['watch', 'watch or alert']])}</label></fieldset>
      <fieldset><legend>Thresholds</legend>
        <label>Watch score ${num('thresholds.watch', c.thresholds.watch, 0.01, 0, 1)}</label><label>Alert score ${num('thresholds.alert', c.thresholds.alert, 0.01, 0, 1)}</label>
        <label>Review round → watch ${num('thresholds.reviewRoundWatch', c.thresholds.reviewRoundWatch, 1, 1, 1000)}</label><label>Review round → alert ${num('thresholds.reviewRoundAlert', c.thresholds.reviewRoundAlert, 1, 1, 1000)}</label>
        <label>Same command in a row → alert ${num('thresholds.backToBackRepeat', c.thresholds.backToBackRepeat, 1, 2, 1000)}</label>
        <label>Claude Code at most ${sel('claudeMaxLevel', c.claudeMaxLevel, [['calm', 'calm (off)'], ['watch', 'watch'], ['alert', 'alert']])}</label></fieldset>
      <fieldset><legend>Sources and archive</legend>
        <label><input type="checkbox" data-spin="sources.codex"${c.sources.codex ? ' checked' : ''}> Codex</label><label><input type="checkbox" data-spin="sources.claude"${c.sources.claude ? ' checked' : ''}> Claude Code</label>
        <label>Keep episodes (days, blank = forever) ${num('episodes.retentionDays', c.episodes.retentionDays, 1, 1, 36500)}</label></fieldset>
      <p class="fr-spin-note">Archive: ${Number(archive.episodes || 0).toLocaleString()} episodes in ${Number(archive.threads || 0).toLocaleString()} sessions, ${((archive.bytes || 0) / 1e6).toFixed(1)} MB. Hook installed: Codex ${hooks.codex ? 'yes' : 'no'}, Claude Code ${hooks.claude ? 'yes' : 'no'}. ${escape(info.configFile || '')}</p>
      <button type="submit">Save spin settings</button> <span data-spin-status></span></form>`;
  }
  function readForm(form, base) {
    const next = JSON.parse(JSON.stringify(base));
    for (const input of form.querySelectorAll('[data-spin]')) {
      const keys = input.dataset.spin.split('.'); let target = next;
      for (const key of keys.slice(0, -1)) target = target[key] = target[key] || {};
      const key = keys[keys.length - 1];
      target[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    }
    return next;
  }
  function mountSpinSettings(host) {
    let current = null, setup = null;
    async function loadSetup() {
      try {
        const response = await fetch('/api/spin/setup'); const value = await response.json();
        if (!response.ok || !value || typeof value.text !== 'string') return;
        setup = value;
        const slot = host.querySelector && host.querySelector('[data-spin-setup]');
        if (slot) { slot.textContent = value.text; slot.hidden = false; }
      } catch (_) { /* the settings still work without the status */ }
    }
    async function refresh() {
      loadSetup();
      try {
        const response = await fetch('/api/spin/config'); const info = await response.json();
        if (!response.ok) throw new Error(info.error || 'Spin settings unavailable');
        current = info.config; host.innerHTML = settingsForm(info.config, info, setup);
      } catch (error) { host.innerHTML = `<p class="fr-error">${escape(error.message)}</p>`; }
    }
    host.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target.closest('[data-spin-form]'); if (!form || !current) return;
      const status = form.querySelector('[data-spin-status]');
      try {
        const response = await fetch('/api/spin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readForm(form, current)) });
        const result = await response.json();
        if (!response.ok) throw new Error((result.errors || [result.error]).join('; '));
        current = result.config; status.textContent = 'Saved. The hook reads this on its next run.';
      } catch (error) { status.textContent = error.message; }
    });
    refresh();
    return { refresh };
  }

  // Global indicator: visible on every tab, counts unacknowledged spin findings
  // from the last 24 hours, and only opens the Brief filtered to spin.
  function badgeCount(summary, state) {
    const now = Date.now();
    return (summary.items || []).filter(item => !state.dismissed[item.id] && !(state.snoozed[item.id] > now) && !state.acknowledged[item.id]);
  }
  function mountSpinBadge(node, { intervalMs = 15000 } = {}) {
    if (!node) return null;
    async function poll() {
      try {
        const response = await fetch('/api/spin/summary'); if (!response.ok) return;
        const summary = await response.json();
        window.dispatchEvent(new CustomEvent('burnboard:spin-summary', { detail: summary }));
        const items = badgeCount(summary, readState());
        node.hidden = !items.length;
        node.classList.toggle('is-alert', items.some(item => item.level === 'alert'));
        const count = node.querySelector('b'); if (count) count.textContent = String(items.length);
        node.title = items.length ? `Spin watch: ${items.map(item => `${item.level} · ${item.title || item.repo}`).slice(0, 5).join('\n')}` : 'Spin watch: nothing churning';
      } catch (_) {}
    }
    poll();
    const timer = setInterval(poll, intervalMs);
    window.addEventListener('storage', poll);
    window.addEventListener('burnboard:spin-state', poll);
    return { poll, destroy() { clearInterval(timer); window.removeEventListener('storage', poll); window.removeEventListener('burnboard:spin-state', poll); } };
  }
  return { mount, mountSpinBadge, investigationUrl, severityRank, findingOrder, focusFromHash, sparkline, settingsForm, readForm, badgeCount, spinOutcome, summarySignature };
});
