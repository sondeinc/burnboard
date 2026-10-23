(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BurnboardProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // A shared "work is happening" indicator. The server reports a phase plus
  // done/total (and a percent when it can be measured); this renders a
  // determinate bar for measured phases, an animated indeterminate bar for
  // phases with no known total, and an error state that never keeps spinning.
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = value => Number(value || 0).toLocaleString();
  const PHASES = {
    starting: { label: 'Starting', verb: '' },
    index: { label: 'Indexing transcripts', verb: 'Indexed' },
    analyze: { label: 'Analyzing sessions', verb: 'Analyzed' },
    spin: { label: 'Loading spin archive', verb: 'Read' },
    rescore: { label: 'Rescoring spin threads', verb: 'Rescored' },
    idle: { label: 'Finishing up', verb: '' },
  };
  const percentOf = progress => {
    if (!progress) return null;
    if (Number.isFinite(progress.percent)) return Math.max(0, Math.min(100, Math.round(progress.percent)));
    if (progress.total > 0 && Number.isFinite(progress.done)) return Math.max(0, Math.min(100, Math.round(progress.done / progress.total * 100)));
    return null;
  };
  // Plain-words status line, e.g. "Indexed 1,240 of 3,700 sessions · 34%".
  function describe(progress, { elapsedMs = 0 } = {}) {
    const p = progress || {};
    if (p.error) return { label: 'Something went wrong', text: String(p.error), determinate: false, percent: null, error: true };
    const phase = PHASES[p.phase] || { label: p.label || 'Working', verb: '' };
    const label = p.label || phase.label;
    const percent = p.determinate === false ? null : percentOf(p);
    const unit = p.unit || 'items';
    const elapsed = elapsedMs >= 2000 ? ` · ${Math.round(elapsedMs / 1000)} s` : '';
    if (percent != null && p.total > 0) {
      const size = p.bytesTotal >= 1e9 ? [1e9, 'GB'] : [1e6, 'MB'];
      const bytes = p.bytesTotal > 0 && p.phase === 'index' ? ` (${(p.bytesDone / size[0]).toFixed(1)} of ${(p.bytesTotal / size[0]).toFixed(1)} ${size[1]})` : '';
      return { label, text: `${phase.verb || 'Done'} ${number(p.done)} of ${number(p.total)} ${unit}${bytes} · ${percent}%`, determinate: true, percent, error: false };
    }
    const counted = p.done > 0 ? `${number(p.done)} ${unit} so far` : 'Working';
    return { label, text: `${counted}${elapsed}`, determinate: false, percent: null, error: false };
  }
  function markup(progress, options = {}) {
    const d = describe(progress, options);
    const title = options.title ? `<span class="bb-progress-title">${escape(options.title)}</span>` : '';
    const state = d.error ? 'error' : d.determinate ? 'determinate' : 'indeterminate';
    const bar = d.error ? '' : d.determinate
      ? `<div class="bb-progress-track" role="progressbar" aria-label="${escape(d.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${d.percent}" aria-valuetext="${escape(d.text)}"><span class="bb-progress-fill" style="width:${d.percent}%"></span></div>`
      : `<div class="bb-progress-track" role="progressbar" aria-label="${escape(d.label)}" aria-valuetext="${escape(d.text)}"><span class="bb-progress-fill"></span></div>`;
    return `<div class="bb-progress" data-state="${state}"${d.error ? ' role="alert"' : ''}>${title}<div class="bb-progress-head">${d.error ? '' : '<span class="bb-progress-spinner" aria-hidden="true"></span>'}<strong class="bb-progress-phase">${escape(d.label)}</strong></div>${bar}<p class="bb-progress-text" aria-live="polite">${escape(d.text)}</p></div>`;
  }
  // Updates an existing indicator in place (so the live region and focus stay
  // put between polls); falls back to replacing the host's markup.
  function render(host, progress, options = {}) {
    if (!host) return;
    const existing = host.querySelector && host.querySelector('.bb-progress');
    const d = describe(progress, options);
    const state = d.error ? 'error' : d.determinate ? 'determinate' : 'indeterminate';
    if (existing && existing.dataset && existing.dataset.state === state && !d.error) {
      const phase = existing.querySelector('.bb-progress-phase'), text = existing.querySelector('.bb-progress-text');
      const track = existing.querySelector('.bb-progress-track'), fill = existing.querySelector('.bb-progress-fill');
      if (phase && phase.textContent !== d.label) phase.textContent = d.label;
      if (text && text.textContent !== d.text) text.textContent = d.text;
      if (track) { track.setAttribute('aria-label', d.label); track.setAttribute('aria-valuetext', d.text); if (d.determinate) track.setAttribute('aria-valuenow', String(d.percent)); }
      if (fill && d.determinate) fill.style.width = `${d.percent}%`;
      return;
    }
    host.innerHTML = markup(progress, options);
  }
  // Investigation status (from /api/investigate/*) as an index-phase progress.
  function fromIndexStatus(status) {
    const s = status || {};
    const percent = s.bytesTotal > 0 ? s.bytesDone / s.bytesTotal * 100 : s.total > 0 ? s.done / s.total * 100 : null;
    return { phase: 'index', unit: 'sessions', done: s.done || 0, total: s.total || 0, bytesDone: s.bytesDone || 0, bytesTotal: s.bytesTotal || 0,
      percent, determinate: s.total > 0 };
  }
  // Polls a progress endpoint about once a second and renders into every host
  // until stop() (the real content replaces it) or fail() (shows the error).
  function createLoader(hosts, { url = '/api/flight/progress', intervalMs = 1000, title = '', fetchImpl, now = () => Date.now(), onProgress = null } = {}) {
    const targets = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean);
    const get = fetchImpl || (typeof fetch === 'function' ? (...args) => fetch(...args) : null);
    let timer = null, stopped = true, started = now(), last = { phase: 'starting' }, misses = 0;
    const paint = progress => { for (const host of targets) render(host, progress, { title, elapsedMs: now() - started }); };
    async function tick() {
      if (stopped || !get) return;
      try {
        const response = await get(url, { cache: 'no-store' });
        const body = await response.json();
        if (stopped) return;
        if (!response.ok) throw new Error(body && body.error || `Progress unavailable (${response.status})`);
        misses = 0; last = body && body.phase ? body : last;
        paint(last);
        if (onProgress && onProgress(last) === false) stop();
      } catch (error) {
        if (stopped) return;
        if (++misses >= 5) return fail(`Lost contact with burnboard while loading: ${error.message}`);
        paint(last);
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    }
    function start() { stopped = false; started = now(); paint(last); timer = setTimeout(tick, Math.min(250, intervalMs)); return api; }
    function stop() { stopped = true; clearTimeout(timer); timer = null; }
    function fail(message) { stop(); paint({ error: message || 'Loading failed' }); }
    const api = { start, stop, fail, tick, get active() { return !stopped; } };
    return api;
  }
  return { describe, markup, render, createLoader, fromIndexStatus, percentOf, PHASES };
});
