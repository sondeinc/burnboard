(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BurnboardSpinHelp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Plain-language help for the Spin watch settings: the "(i)" pop-ups in the
  // Attention Brief and the "Setting explanations" block in the README are both
  // built from TOPICS, so they cannot drift apart. Every statement here has to
  // match lib/spin.js, lib/spin-store.js and bin/spin-hook.js; the tests check
  // the defaults, the nudge message and the rescore notes against the code.
  //
  // A topic: { title, setting: [config paths it explains], defaults: { path: text },
  //   text: [paragraphs], list: [{ name, text }] (optional), scorer: true | false | null }.
  // scorer is true when the setting is part of the scorer version (changing it
  // asks for a rescore), false when it is not, null for explanations that are
  // not a setting.

  const RESCORE_YES = 'Rescore: yes. This setting is part of the scorer version, so after a change the brief offers “Rescore now”; threads scored before the change keep their earlier scores until you rescore.';
  const RESCORE_NO = 'Rescore: no. This setting does not change scores, so changing it never needs a rescore.';
  const NUDGE_TAIL = 'Pause and post to the user: the original goal, what is concretely left, and whether another round/gate is worth it. Continue only if you can justify it.';
  const CAP_WARNING = 'Claude Code threads never go above “Claude Code at most”. If that cap is below this level, as with the defaults (cap at watch, this setting at alert only), Claude Code threads are never';

  const TOPICS = {
    scoreCalc: {
      title: 'How the churn score is calculated', setting: [], scorer: null,
      text: [
        'Every 40 actions (a command or tool call, a file edit, or a helper-agent launch) spin watch takes a reading over the last three blocks of 40, about 120 actions. It measures the five signals below and compares each with the reference sessions that ship with burnboard, so each becomes “higher than X% of sessions”, a number from 0 to 1. The five are averaged with equal weight, and the churn score is the average of the last three readings, so a thread needs about 120 actions before it gets one.',
      ],
      list: [
        { name: 'Process ceremony share', text: 'The share of recent commands that are process upkeep rather than new work: merging main back in, rebasing, pulling or fetching (git pull, git fetch, git ls-remote), worktree add, list or prune, checking a PR or CI run (gh pr view or checks, gh run view, watch or rerun, gh workflow run), regenerating files or codegen, lint-fix and format runs, snapshot updates, and review-round, receipt, attestation or changeset bookkeeping. Which commands count comes from the ceremony pattern list in spin.json, which you can change. Example: 30 such commands out of 60 is a share of 50%.' },
        { name: 'New files touched', text: 'How many files the agent edited for the first time in this session during those ~120 actions. This signal is flipped: fewer new files is more churn-like, so an agent that edits nothing new for 120 actions scores high here.' },
        { name: 'Highest review round mentioned', text: 'The highest round number seen so far in the session. It comes from the start (first 400 characters) of the agent’s own messages when they say “round N”, “pass N” or “rnd N”, and from helper-agent names that match the review-helper list (by default names containing review, audit, critic, verif, adversar, quality or edge) and contain a number of up to three digits. Example: “Starting review round 14” or a helper named “audit-14” counts as round 14.' },
        { name: 'Waiting per action', text: 'How many times the agent waited, divided by the number of actions. A wait is a call that waits on a helper agent or on a command that is still running (in Claude Code: checking background output or a monitor). Example: 30 waits over 120 actions is 0.25 per action. Polling commands such as git status or sleep are not counted here; repeated, they show up as near-repeats.' },
        { name: 'Near-repeat commands', text: 'The share of commands that repeat the “shape” of a command from the last 160 actions. The shape is the command with numbers, commit hashes, ids, temporary paths and repository or worktree paths replaced, and leading cd, export and environment settings removed. Example: “gh pr checks 812” followed later by “gh pr checks 815” is a near-repeat.' },
      ],
    },
    watch: {
      title: 'Watch score threshold', setting: ['thresholds.watch'], defaults: { 'thresholds.watch': '0.70' }, scorer: true,
      text: [
        'A thread is marked “watch” when its churn score reaches this number (default 0.70). The score looks at the agent’s last ~120 actions and measures five signals; each is compared with a reference set of past sessions, so it becomes “higher than X% of sessions”. The five are averaged with equal weight and smoothed over the last three readings: 0 means calm, 1 means as churn-like as the worst sessions on record. Example: 0.70 means the five signals sit, on average, higher than 70% of the reference sessions.',
        'Raising it means fewer false alarms but catches churn later; lowering it catches churn sooner but flags more ordinary work.',
      ],
    },
    alert: {
      title: 'Alert score threshold', setting: ['thresholds.alert'], defaults: { 'thresholds.alert': '0.85' }, scorer: true,
      text: [
        'A thread is marked “alert” when its churn score reaches this number (default 0.85); it must be at least the watch score. It is the same churn score as the watch threshold: the last ~120 actions, five signals each ranked against past sessions, averaged equally and smoothed over three readings, from 0 (calm) to 1 (as churn-like as the worst sessions on record). Example: 0.85 means the signals sit, on average, higher than 85% of the reference sessions.',
        'Raising it means fewer false alarms but alerts on churn later (or leaves it at watch); lowering it alerts sooner but more often on ordinary work.',
      ],
    },
    reviewRoundWatch: {
      title: 'Review round watch', setting: ['thresholds.reviewRoundWatch'], defaults: { 'thresholds.reviewRoundWatch': '20' }, scorer: true,
      text: [
        'A thread is marked at least “watch” when a review round of this number or higher (default 20) appears in its recent activity, whatever its churn score. A review round is a number the agent states in its own messages as “round N”, “pass N” or “rnd N”, or a review-helper name that says so explicitly, such as “review-round-23”, “audit-r23” or “critic pass 23”. Only rounds seen in about the last 200 actions count, so an old round stops counting once the thread moves on.',
      ],
    },
    reviewRoundAlert: {
      title: 'Review round alert', setting: ['thresholds.reviewRoundAlert'], defaults: { 'thresholds.reviewRoundAlert': '40' }, scorer: true,
      text: [
        'A thread is marked “alert” when a review round of this number or higher (default 40) appears in its recent activity, whatever its churn score; it must be at least the watch round. Rounds are read the same way as for the watch round: “round N”, “pass N” or “rnd N” in the agent’s messages, or an explicit round in a review-helper name, seen in about the last 200 actions. Example: an agent that writes “Starting round 41” is marked alert.',
      ],
    },
    backToBackRepeat: {
      title: 'Same command in a row', setting: ['thresholds.backToBackRepeat'], defaults: { 'thresholds.backToBackRepeat': '5' }, scorer: true,
      text: [
        'When the agent runs exactly the same command this many times in a row (default 5), the thread is marked “alert” and stays there for the next 80 actions. “The same” means identical text: any file edit, helper launch or different command in between restarts the count, and commands that differ only by a number don’t count here (they feed the near-repeat signal instead).',
        'Waiting and look-only commands, such as sleep, git status, gh pr checks, ls, cat, grep or reading a file, never trigger this alert: when one repeats five or more times in a row, the card reports it as waiting (“waiting: the same check 6 times in a row”) instead.',
      ],
    },
    claudeMaxLevel: {
      title: 'Claude Code at most', setting: ['claudeMaxLevel'], defaults: { claudeMaxLevel: 'watch' }, scorer: true,
      text: [
        'The highest level a Claude Code thread can reach (default watch), because spin watch is less well calibrated on Claude Code transcripts. A Claude Code thread that would be higher is shown at this level, and its card says “capped at watch for Claude Code”. Choose calm (off) to never flag Claude Code threads, or alert to treat them like Codex.',
        'Watch out: notifications and nudges fire only at their own “At” level. If this cap is below that level (for example the defaults: capped at watch, notifications and nudges at alert only), Claude Code threads are never notified or nudged.',
      ],
    },
    desktopLevel: {
      title: 'Desktop notification level', setting: ['desktop.minLevel'], defaults: { 'desktop.minLevel': 'alert' }, scorer: false,
      text: [
        'Which level shows a Windows toast (through the built-in Windows notification API; nothing to install): alert only (default), or watch or alert. A session notifies only when its level goes up, at most once per level in each episode and never within the cooldown. The toast names the tool, repository, session title, level and top reasons, and clicking it opens the Attention Brief filtered to spin watch.',
        `${CAP_WARNING} notified.`,
      ],
    },
    desktopCooldown: {
      title: 'Notification cooldown', setting: ['desktop.cooldownMinutes'], defaults: { 'desktop.cooldownMinutes': '60' }, scorer: false,
      text: [
        'The shortest gap between two toasts for the same session, in minutes (default 60; 0 means no gap). If the level rises again during the cooldown, for example from watch to alert, the toast waits: it appears on the agent’s next action after the cooldown ends, if the level is still up.',
      ],
    },
    nudgeMode: {
      title: 'Agent nudge mode', setting: ['agentNudge.mode'], defaults: { 'agentNudge.mode': 'shadow' }, scorer: false,
      text: [
        'What spin watch tells the agent itself. Off: nothing. Shadow (default): it only writes the message it would have sent to its event log (events.jsonl), so you can see what a nudge would say. Nudge: it adds the message to the agent’s context after a tool call, once per level in each episode. It never stops or blocks the agent.',
        `The message is: “Spin check: (the top reasons). ${NUDGE_TAIL}”`,
      ],
    },
    nudgeLevel: {
      title: 'Agent nudge level', setting: ['agentNudge.minLevel'], defaults: { 'agentNudge.minLevel': 'alert' }, scorer: false,
      text: [
        'Which level sends the nudge (or, in shadow mode, logs it): alert only (default), or watch or alert. Each episode is nudged at most once per level, when its level goes up.',
        `${CAP_WARNING} nudged.`,
      ],
    },
    retention: {
      title: 'Episode retention', setting: ['episodes.retentionDays'], defaults: { 'episodes.retentionDays': 'blank' }, scorer: false,
      text: [
        'How many days archived episodes are kept. Blank (default) keeps them forever. With a number, the hook checks at most once a day and deletes episodes that ended (or were last active) more than that many days ago, along with missed callouts that old; a session’s own hand label is kept. Example: 90 keeps about three months of history.',
      ],
    },
    patterns: {
      title: 'Pattern lists', setting: ['ceremonyPatterns', 'gatePatterns', 'mergePatterns', 'reviewHelperPatterns'], scorer: true,
      text: [
        'Four lists of regular expressions, set in spin.json (the settings form does not edit them). Ceremony patterns mark process-ceremony commands; gate patterns name heavy check scripts (a package, node or shell run of one counts as a gate run, and a card can say “3 heavy gate runs in 40 min”); merge patterns mark a successful merge, which can label the episode “merged”; review-helper patterns mark helper names whose numbers count as review rounds.',
        'The built-in lists are project-neutral, and each list you set replaces its built-in list, so add your own project’s command names there.',
      ],
    },
    activity: {
      title: 'Activity timers', setting: ['activity.activeMinutes', 'activity.abandonHours'], defaults: { 'activity.activeMinutes': '5', 'activity.abandonHours': '12' }, scorer: false,
      text: [
        'Set in spin.json as activity.activeMinutes (default 5) and activity.abandonHours (default 12). They only change how an open episode’s card reads: “active” while the thread’s newest recorded event is at most that many minutes old, then “idle since HH:MM”, then “abandoned” once that many hours pass with no activity.',
      ],
    },
  };

  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const note = topic => topic.scorer === true ? RESCORE_YES : topic.scorer === false ? RESCORE_NO : '';
  const popId = key => `spin-help-${key}`;
  const topic = key => {
    const value = TOPICS[key];
    if (!value) throw new Error(`Unknown spin help topic: ${key}`);
    return value;
  };

  // Plain text of a pop-up, in reading order (used by tests and the README).
  function plainText(key) {
    const t = topic(key);
    return [...t.text, ...(t.list || []).map(item => `${item.name}: ${item.text}`), note(t)].filter(Boolean).join('\n');
  }

  // The "(i)" button and its (hidden) pop-up. The pop-up follows the button in
  // the document, so keyboard users reach its contents by tabbing on.
  function button(key) {
    const t = topic(key), id = popId(key), rescore = note(t);
    return `<button type="button" class="fr-help-btn" data-spin-help="${escape(key)}" aria-label="About ${escape(t.title)}" aria-expanded="false" aria-controls="${id}">i</button>`
      + `<div class="fr-help-pop" id="${id}" data-spin-help-pop="${escape(key)}" role="dialog" aria-labelledby="${id}-title" tabindex="-1" hidden>`
      + `<h5 id="${id}-title">${escape(t.title)}</h5>`
      + t.text.map(text => `<p>${escape(text)}</p>`).join('')
      + (t.list ? `<ol>${t.list.map(item => `<li><b>${escape(item.name)}.</b> ${escape(item.text)}</li>`).join('')}</ol>` : '')
      + (rescore ? `<p class="fr-help-rescore" data-rescore="${t.scorer ? 'yes' : 'no'}">${escape(rescore)}</p>` : '')
      + '</div>';
  }

  // README "Setting explanations" block, regenerated by scripts/spin-help-readme.js.
  const README_START = '<!-- spin-help:start (generated from lib/ui/spin-help.js by scripts/spin-help-readme.js; do not edit by hand) -->';
  const README_END = '<!-- spin-help:end -->';
  function markdown() {
    const lines = [README_START];
    for (const t of Object.values(TOPICS)) {
      lines.push('', `- **${t.title}.** ${t.text.join(' ')}`);
      for (const item of t.list || []) lines.push(`  - *${item.name}.* ${item.text}`);
      if (note(t)) lines.push(`  ${note(t)}`);
    }
    lines.push('', README_END);
    return lines.join('\n');
  }

  // Where to put a pop-up of the given size under (or above) its button so it
  // stays inside the viewport, with an 8px margin.
  function place(rect, size, viewport, margin = 8, gap = 6) {
    const width = Math.min(size.width, viewport.width - 2 * margin);
    const height = Math.min(size.height, viewport.height - 2 * margin);
    const left = Math.max(margin, Math.min(rect.left, viewport.width - margin - width));
    let top = rect.bottom + gap;
    if (top + height > viewport.height - margin) {
      const above = rect.top - gap - height;
      top = above >= margin ? above : Math.max(margin, viewport.height - margin - height);
    }
    return { left: Math.round(left), top: Math.round(top), maxWidth: Math.round(viewport.width - 2 * margin), maxHeight: Math.round(viewport.height - 2 * margin) };
  }

  // Behaviour for every "(i)" inside root: click, tap, Enter or Space toggles a
  // pop-up; a mouse hover previews it; Escape or a click outside closes it; only
  // one is open at a time. root keeps its listeners when its contents are
  // re-rendered.
  function attach(root, { doc = typeof document !== 'undefined' ? document : null, win = typeof window !== 'undefined' ? window : null, hoverDelayMs = 200 } = {}) {
    if (!root || !root.addEventListener || !doc || !doc.addEventListener) return null;
    let open = null; // { key, button, pop, pinned }
    let skipClick = false, hoverTimer = null;
    const buttonFor = key => root.querySelector(`[data-spin-help="${key}"]`);
    const popFor = key => root.querySelector(`[data-spin-help-pop="${key}"]`);
    const within = (node, selector) => node && node.closest ? node.closest(selector) : null;
    const insideOpen = node => !!open && node && (open.pop.contains(node) || open.button.contains(node));
    function position() {
      if (!open || !win || !open.button.getBoundingClientRect) return;
      const rect = open.button.getBoundingClientRect();
      const size = { width: open.pop.offsetWidth || 320, height: open.pop.offsetHeight || 160 };
      // The root element's client size leaves out scrollbars; innerWidth does not.
      const page = doc.documentElement || {};
      const spot = place(rect, size, { width: page.clientWidth || win.innerWidth || 1024, height: page.clientHeight || win.innerHeight || 768 });
      Object.assign(open.pop.style, { left: `${spot.left}px`, top: `${spot.top}px`, maxWidth: `${spot.maxWidth}px`, maxHeight: `${spot.maxHeight}px` });
    }
    function close({ restoreFocus = false } = {}) {
      clearTimeout(hoverTimer); hoverTimer = null;
      if (!open) return;
      const current = open; open = null;
      current.pop.hidden = true;
      current.button.setAttribute('aria-expanded', 'false');
      if (restoreFocus && current.button.focus) current.button.focus();
    }
    function show(key, { pinned = true, focus = false } = {}) {
      clearTimeout(hoverTimer); hoverTimer = null;
      if (open && open.key === key) { open.pinned = open.pinned || pinned; if (focus && open.pop.focus) open.pop.focus(); return; }
      close();
      const btn = buttonFor(key), pop = popFor(key);
      if (!btn || !pop) return;
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      open = { key, button: btn, pop, pinned };
      position();
      if (focus && pop.focus) pop.focus();
    }
    function toggle(key, focus) {
      if (open && open.key === key && open.pinned) close({ restoreFocus: focus });
      else show(key, { pinned: true, focus });
    }
    const onClick = event => {
      const btn = within(event.target, '[data-spin-help]');
      if (!btn) return;
      event.preventDefault();
      if (skipClick && !event.detail) { skipClick = false; return; } // the click a key press already handled
      // detail 0: a keyboard or assistive-technology click; move focus into the pop-up.
      toggle(btn.getAttribute('data-spin-help'), !event.detail);
    };
    const onKeyDown = event => {
      const btn = within(event.target, '[data-spin-help]');
      if (!btn || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar')) return;
      event.preventDefault();
      skipClick = true;
      toggle(btn.getAttribute('data-spin-help'), true);
    };
    const onKeyUp = event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') setTimeout(() => { skipClick = false; }, 0);
    };
    const onOver = event => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const btn = within(event.target, '[data-spin-help]');
      if (btn) { if (!open || !open.pinned) show(btn.getAttribute('data-spin-help'), { pinned: false }); return; }
      if (open && insideOpen(event.target)) { clearTimeout(hoverTimer); hoverTimer = null; }
    };
    const onOut = event => {
      if (!open || open.pinned || !insideOpen(event.target) || insideOpen(event.relatedTarget)) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => { if (open && !open.pinned) close(); }, hoverDelayMs);
    };
    const onFocusOut = event => {
      if (open && event.relatedTarget && insideOpen(event.target) && !insideOpen(event.relatedTarget)) close();
    };
    const onDocClick = event => { if (open && !insideOpen(event.target)) close(); };
    const onDocKey = event => {
      if (open && (event.key === 'Escape' || event.key === 'Esc')) {
        event.preventDefault();
        const focusWasInside = insideOpen(doc.activeElement);
        close({ restoreFocus: focusWasInside || open.pinned });
      }
    };
    const onMove = () => position();
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('keyup', onKeyUp);
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('focusout', onFocusOut);
    doc.addEventListener('click', onDocClick);
    doc.addEventListener('keydown', onDocKey);
    if (win && win.addEventListener) { win.addEventListener('resize', onMove); win.addEventListener('scroll', onMove, true); }
    return {
      open: key => show(key), close, current: () => (open ? open.key : null), position,
      destroy() {
        close();
        root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKeyDown); root.removeEventListener('keyup', onKeyUp);
        root.removeEventListener('pointerover', onOver); root.removeEventListener('pointerout', onOut); root.removeEventListener('focusout', onFocusOut);
        doc.removeEventListener('click', onDocClick); doc.removeEventListener('keydown', onDocKey);
        if (win && win.removeEventListener) { win.removeEventListener('resize', onMove); win.removeEventListener('scroll', onMove, true); }
      },
    };
  }

  return { TOPICS, RESCORE_YES, RESCORE_NO, NUDGE_TAIL, button, plainText, markdown, place, attach, README_START, README_END };
});
