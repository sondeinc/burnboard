(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BurnboardFlightRecorder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE = 'burnboard.flight-recorder.v1';
  const RULE_LABELS = {
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
  function mount(attentionRoot, boardRoot, options = {}) {
    const state = readState(), openedAt = Date.now();
    const previousVisit = state.lastVisit || openedAt - 8 * 3600000;
    let overview = null, busy = false, queued = false, showAll = false;
    const enabledRules = () => Object.keys(RULE_LABELS).filter(rule => !state.disabledRules.includes(rule));
    const since = () => state.range === 'last' ? previousVisit : openedAt - Number(state.range || 8) * 3600000;
    async function load(refresh = true) {
      if (busy) { queued = true; return; }
      busy = true;
      try {
        const params = new URLSearchParams({ since: String(since()), rules: enabledRules().join(','), ...(refresh ? {} : { refresh: '0' }) });
        const response = await fetch('/api/flight/overview?' + params);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Release Two analysis failed');
        overview = result; render();
      } catch (error) {
        if (attentionRoot) attentionRoot.innerHTML = `<div class="fr-error">${escape(error.message)}</div>`;
        if (boardRoot) boardRoot.innerHTML = `<div class="fr-error">${escape(error.message)}</div>`;
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
    function renderFinding(finding) {
      const status = findingState(finding);
      if (status === 'dismissed' || status === 'snoozed') return '';
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
    function renderAttention() {
      if (!attentionRoot || !overview) return;
      const x = window.scrollX, y = window.scrollY;
      const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-fr]');
      const focus = focused && { action: focused.dataset.fr, id: focused.dataset.id };
      const opened = new Set([...attentionRoot.querySelectorAll('.fr-finding details[open]')].map(details => details.closest('.fr-finding').dataset.finding));
      const findings = overview.findings.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.to || 0) - (a.to || 0));
      const visible = findings.filter(finding => !['dismissed', 'snoozed'].includes(findingState(finding)));
      const shown = showAll ? visible : visible.slice(0, 12);
      const coverage = overview.coverage || {};
      const coverageText = coverage.availableSessions > coverage.analyzedSessions ? `Newest ${coverage.analyzedSessions.toLocaleString()} of ${coverage.availableSessions.toLocaleString()} indexed sessions analyzed.` : `${(coverage.analyzedSessions || 0).toLocaleString()} indexed sessions analyzed.`;
      const omittedText = coverage.matchedFindings > coverage.returnedFindings ? ` Showing ${coverage.returnedFindings.toLocaleString()} of ${coverage.matchedFindings.toLocaleString()} matched findings.` : '';
      attentionRoot.innerHTML = `<section class="fr-attention"><div class="fr-heading"><div><span class="fr-eyebrow">Release Two · deterministic local signals</span><h2>Attention brief</h2><p>${visible.length ? `${visible.length} recorded pattern${visible.length === 1 ? '' : 's'} worth a look.` : 'No enabled attention rule fired in this interval.'} Nothing here stops or reruns an agent.</p><p class="fr-coverage">${escape(coverageText)}${coverage.truncatedSessions ? ` ${coverage.truncatedSessions.toLocaleString()} session${coverage.truncatedSessions === 1 ? '' : 's'} used the newest ${coverage.maxEventsPerSession.toLocaleString()} events plus the first request.` : ''}</p></div>
        <div class="fr-controls"><label>Since<select data-fr="range"><option value="last"${state.range === 'last' ? ' selected' : ''}>Last visit · ${escape(clock(previousVisit))}</option>${[1, 8, 24, 72].map(hours => `<option value="${hours}"${String(state.range) === String(hours) ? ' selected' : ''}>Last ${hours}h</option>`).join('')}</select></label>
        <details><summary>Rule controls</summary>${Object.entries(RULE_LABELS).map(([rule, label]) => `<label><input type="checkbox" data-fr="rule" value="${rule}"${state.disabledRules.includes(rule) ? '' : ' checked'}> ${escape(label)}</label>`).join('')}</details></div></div>
        <div class="fr-brief">${overview.brief.map(row => `<div><strong>${escape(row.repo)}</strong><span title="${escape(row.cwd)}">${escape(row.cwd || 'Worktree not recorded')}</span><b>${row.sessions} session${row.sessions === 1 ? '' : 's'} · ${row.findings} finding${row.findings === 1 ? '' : 's'}</b></div>`).join('') || '<p>No recorded activity in this interval.</p>'}</div>
        <div class="fr-findings">${shown.map(renderFinding).join('') || '<div class="fr-clear">All clear for the enabled rules and interval. Unknown or incomplete records remain visible in Investigate source health.</div>'}</div>
        ${visible.length > 12 ? `<button class="fr-more" type="button" data-fr="show-all">${showAll ? 'Show highest-priority 12' : `Show all ${visible.length.toLocaleString()} findings`}</button>` : ''}</section>`;
      const coverageNode = attentionRoot.querySelector('.fr-coverage'); if (coverageNode) coverageNode.append(omittedText);
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
      if (action === 'show-all') { showAll = !showAll; return renderAttention(); }
      saveState(state); render();
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
    state.lastVisit = openedAt; saveState(state); load();
    return { load, destroy() { window.removeEventListener('burnboard:investigation-status', live); } };
  }
  return { mount, investigationUrl, severityRank };
});
