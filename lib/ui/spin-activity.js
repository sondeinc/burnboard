(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BurnboardSpinActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Whether a spin watch thread is still going, judged from the newest event
  // the hook or backfill saw in its transcript (any action or message), never
  // from file times. Shared by the server (Brief and summary API) and the
  // browser (which re-labels cards as time passes), so both use the same words.
  // Display only: none of this is part of the scorer version.
  //
  //   open episode, last activity <= activeMinutes ago   -> "active"
  //   open episode, after that                          -> "idle since HH:MM"
  //   open episode, more than abandonHours without any  -> "abandoned"
  //   closed episode                                    -> its recorded outcome
  const DEFAULT_ACTIVE_MINUTES = 5; // same clock as the Activity tab's idle dot
  const DEFAULT_ABANDON_HOURS = 12;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const finite = value => value != null && Number.isFinite(+value) && +value > 0;
  function thresholds(settings) {
    const s = settings || {};
    const active = Number(s.activeMinutes), abandon = Number(s.abandonHours);
    return {
      activeMinutes: Number.isFinite(active) && active > 0 ? active : DEFAULT_ACTIVE_MINUTES,
      abandonHours: Number.isFinite(abandon) && abandon > 0 ? abandon : DEFAULT_ABANDON_HOURS,
    };
  }
  // Newest recorded activity for an episode: the thread's last seen event, or
  // the episode's own times when the thread header has none. A thread time
  // past "now" (clock skew) counts as now.
  function lastActivity(ep, thread, now = Date.now()) {
    const own = [ep && ep.lastHotT, ep && ep.start].filter(finite).map(Number);
    const seen = thread && finite(thread.lastSeen) ? Math.min(+thread.lastSeen, now) : null;
    const times = seen == null ? own : [...own, seen];
    return times.length ? Math.max(...times) : null;
  }
  function closedOutcome(ep) {
    if (ep.callouts && ep.callouts.length) return 'user called it out';
    if (ep.merged) return 'merged';
    return ep.endReason === 'calm' ? 'converged' : 'abandoned';
  }
  const pad = n => String(n).padStart(2, '0');
  // Local time, with the date when it is not today (and the year when not this year).
  function sinceText(t, now = Date.now()) {
    const d = new Date(t), today = new Date(now);
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === today.toDateString()) return hhmm;
    const date = `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === today.getFullYear() ? '' : `, ${d.getFullYear()}`}`;
    return `${date} ${hhmm}`;
  }
  function activityState(at, now, settings) {
    const { activeMinutes, abandonHours } = thresholds(settings);
    if (at == null) return 'abandoned';
    const age = now - at;
    if (age <= activeMinutes * 60000) return 'active';
    if (age > abandonHours * 3600000) return 'abandoned';
    return 'idle';
  }
  // { state, label, open, lastActivity }. state is the short word ("active",
  // "idle", "abandoned", or a closed outcome); label is what a card shows.
  // An open episode the user called out (or that merged) keeps that word in
  // front of its activity: "user called it out · idle since 14:05".
  function describe(ep, { now = Date.now(), thread = null, at, settings = null } = {}) {
    if (ep.end != null) {
      const outcome = closedOutcome(ep);
      return { state: outcome, label: outcome, open: false, lastActivity: ep.end };
    }
    const seen = at === undefined ? lastActivity(ep, thread, now) : at;
    const state = activityState(seen, now, settings);
    const word = state === 'idle' ? `idle since ${sinceText(seen, now)}` : state;
    const note = ep.callouts && ep.callouts.length ? 'user called it out' : ep.merged ? 'merged' : '';
    return { state, label: note ? `${note} · ${word}` : word, open: state !== 'abandoned', lastActivity: seen };
  }
  return { DEFAULT_ACTIVE_MINUTES, DEFAULT_ABANDON_HOURS, thresholds, lastActivity, activityState, describe, sinceText, closedOutcome };
});
