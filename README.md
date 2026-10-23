# burnboard

**A live and historical monitor for AI coding agent usage — [OpenAI Codex CLI](https://github.com/openai/codex)
and [Claude Code](https://claude.com/claude-code), side by side.**

<img width="1904" height="1370" alt="image" src="https://github.com/user-attachments/assets/b4dc30d5-39fd-44f6-a9dd-6b3ab57b1221" />


burnboard tails the JSONL session transcripts both tools write locally — Codex to
`~/.codex/sessions/`, Claude Code to `~/.claude/projects/` — and turns them into a local web
dashboard. No account access, no API keys, nothing sent anywhere. One required dependency
for local MessagePack caching; an optional tokenizer for offline text counts.

Every view carries an **All agents / Codex / Claude Code** toggle and its own **repository picker**:
see one tool or one codebase in isolation, or everything together in a single combined view with
each session badged by which agent ran it. Repository choices are independent per tab, so changing
History does not silently change an Economy comparison.

- **Activity** — one live panel per active agent, refreshed every ~2s, with a
  billed-token consumption chart, the current command history, per-command token deltas, and a
  quota/usage bar (weekly rate-limit % + tokens today/this week).
- **Subagent lineage** — spawned-by chains up to the root prompt, including Codex's auto-approval
  `guardian` shown nested under the thread it's reviewing.
- **History** — every past session, sortable, with prompt, model, effort, git branch, billed
  tokens and command count, filtered by clicking the period chart above it. Sessions that changed
  models show the exact usage attributed to each model instead of assigning the whole run to the
  first model seen.
- **Investigate** — a local agent flight recorder with a selectable clock timeline, complete
  source-event inspection, cross-session search, evidence pins, saved investigations, notes, and
  editable handoffs. Its real-time **Live Monitor** is optional and off by default.
- **Attention + Worktrees** — deterministic local findings for repeated failures, pending work,
  and stale validation, plus repository/worktree lanes, recorded edit overlaps, and evidence-linked
  outcome trails. Observations never stop or rerun an agent.
- **Spin watch** — an Attention Brief rule for agents that are churning (review-round treadmills,
  merge-gate ceremony), fed by an optional always-on hook that runs inside Codex and Claude Code
  even when burnboard is closed, with a durable episode archive.
- **Trends** — token consumption bucketed over time, split into two lists (by base command, by
  prompt); click a bar to drill into it, click a row to plot just that command or prompt.
- **Agents** — the same spend cut by *who* spent it, so agent types can be compared on
  efficiency rather than volume.
- **Economy** — a token-waste audit: which commands dump the most output back into context,
  truncation hits, polling/wait round-trips, and commands re-run unchanged — plus ranked findings
  on what to change, grounded in the tooling you actually have.

It also corrects for quirks the raw numbers don't show — Codex's token counter resetting on
context compaction, `total_token_usage` under-counting long sessions, UTC timestamps, JS-wrapped
tool calls, and (on both sides) separating a request's genuinely *new* tokens from the cached
context resent on every turn.

## Run

Requires Node ≥ 18. Run `npm install` before starting the monitor.

```bash
git clone https://github.com/sondeinc/burnboard
cd burnboard
npm install
node server.js            # -> http://localhost:4317
```

Options: `--port 8080`, `--root /path/to/.codex`, `--claude-root /path/to/.claude`, `--no-ai`, `--local-tokens`.

`--no-ai` (or `BURNBOARD_NO_AI=1`) disables **Dive deeper**, the optional feature that runs
a Codex or Claude Code agent to analyze the evidence behind a token-usage finding. Burnboard will
not launch an agent or spend tokens on your behalf; the dashboard and its measured findings still
work.

### Optional offline text-token counting

```bash
npm install --ignore-scripts
node server.js --no-ai --local-tokens
node token-count.js --model gpt-5 /absolute/path/report.json
node token-count.js --encoding o200k_base /absolute/path/report.json
```

`js-tiktoken@1.0.21` is an optional dependency with bundled encoding assets. Installing it
requires the registry once; counting afterward requires no network, API key, inference or report
upload. It works under `--no-ai`. Without it, the monitor still works. Installation with
`npm install --omit=optional` installs the MessagePack cache dependency without the tokenizer.

The Economy view separates `tokenized` logged text from `estimated` outputs and reports UTF-8
bytes for each method. The pinned package's exact model map selects an encoding; unsupported,
missing, Claude and future models retain the explicitly labeled characters/4 estimate. We do
not infer an encoding from a model-name prefix. A package mapping is **not verification of the
live consumer**: `consumerMappingVerified` stays false. In particular, this package does not map
`gpt-5.6-sol` or `gpt-6-astra`; selecting `gpt-5` to count their output would be misleading.

The file/stdin command emits a JSON measurement with tokens, UTF-8 bytes, text SHA256,
encoding-asset SHA256, tokenizer version and mapping method. `--encoding` is an explicitly
chosen encoding, not a verified model mapping. Input must be valid UTF-8, including any BOM and
newlines; it is counted whole, with an 8 MiB limit and no silent truncation. Tool-output
special-token spellings are counted as ordinary text. Exit 0 means tokenized, exit 2 means an
explicit estimate, and exit 1 means invalid/unreadable/oversized input.

This measures **logged text**, not total request input, model output generation, image/audio
tokens or billing. Recorded request usage and approximate per-command attribution remain
unchanged. Codex's original-output truncation marker is retained separately from delivered-text
counts. Parser measurements use the tool call's turn model, not the session's first model.
Changing counting mode or tokenizer availability invalidates the rollup cache and rescans it.
Local tokenization costs extra CPU/memory, so it is opt-in; logged texts over 8 MiB fall back to
an explicitly labeled estimate. `npm test` runs the offline counter/parser and `--no-ai` server
tests (install the optional dependency first).

The page is read fresh on every request, so UI changes only need a browser reload — but the
server holds its routes in memory. After pulling a new version, restart the process, or a page
built against new endpoints will sit waiting on routes the running server answers with 404.

### Finding your data

On startup burnboard locates each agent's home directory and prints what it found. Either source
can be absent — it just shows whichever it finds.

**Codex CLI**, in this order:

1. `--root <dir>`
2. `$CODEX_HOME` (the same variable Codex itself honours)
3. `$XDG_CONFIG_HOME/codex`
4. `~/.codex`, then `~/.config/codex`, then the OS app-support dir

It picks the first one containing a `sessions/` directory.

**Claude Code**, in this order:

1. `--claude-root <dir>`
2. `$CLAUDE_HOME`
3. `~/.claude`

It reads the flat `projects/<project-slug>/<session-id>.jsonl` transcripts underneath.

## What it shows

Seven tabs: **Activity**, **History**, **Investigate**, **Worktrees**, **Trends**, **Agents**, **Economy**.

### Investigate

Open **Investigate** directly or follow an `investigate →` link from Activity. Burnboard builds a
separate, disposable local index; it never modifies the Codex or Claude Code transcripts. Search
messages, tool inputs and results, paths, and recorded identifiers, then filter by repository,
worktree, agent, model, event type, or time. Open the exact original record, pin useful evidence,
add notes, and preview an editable, size-bounded Markdown handoff.

The **Live Monitor** control is an explicit opt-in. When enabled, one localhost event stream
indexes complete records appended to recently active logs. New arrivals update the timeline while
preserving selection, focus, and reading position; following the newest event is a separate choice.
Turning the monitor off closes the stream and stops continuous scanning.

Live Monitor does **not** launch Codex or Claude, call a model, consume model tokens, execute or
rerun commands, stop an agent, or send a notification. The separate **Dive deeper** action in
Economy is the only feature that can ask an installed assistant to interpret evidence, and it runs
only after an explicit click. See
[`docs/investigation.md`](docs/investigation.md) for limits, privacy boundaries, API routes, and the
reproducible performance fixture. [Spin watch](#spin-watch) is a separate, optional hook that
runs inside the agents; it is not part of Live Monitor.

### Attention brief

Activity starts with a return brief covering activity since the previous visit or a selected
1-, 8-, 24-, or 72-hour interval. It groups the result by recorded repository and working
directory, then shows the highest-priority twelve findings first. **Show all** reveals the rest of
the bounded response.

The rules are deliberately narrow and deterministic:

- **spin watch**: an agent kept a churn-like pattern over its last ~120 actions (see
  [Spin watch](#spin-watch));
- the same normalized command produced an equivalent recorded failure more than once;
- the same command and equivalent result repeated at least three times (which may be intentional
  polling, not a defect);
- an identifiable tool call has had no paired result for at least two minutes;
- a direct completion-like claim has no recorded successful validation, or a relevant edit was
  recorded after the latest successful validation; and
- an explicit child session's latest recorded activity has no later acknowledgement recorded in
  its parent.

Every finding names its trigger, severity rationale, time interval, uncertainty, and supporting
events. **Investigate evidence** opens those records in the flight recorder. Acknowledge, dismiss,
snooze, and per-rule controls stay in browser storage; they do not change transcripts or agent
behavior. “No acknowledgement recorded” never means Burnboard knows a result was ignored.

Spin watch findings sort to the top, and each churning session is **one card**: that session's
other findings in the same time span (repeated commands, repeated failures, long waits, and so on)
nest under it as supporting evidence. Sessions without a spin finding render as before. A spin card
shows the plain-English reasons (for example “review round 23”, “5 heavy gate runs in 2 h”,
“1 new file in the last 120 actions”, “same command 6 times in a row”), the score history, the
archived evidence trail, nearby human messages, and the outcome once known (merged, converged,
abandoned, you called it out, or still running). **Investigate evidence** opens the session in the
flight recorder.

The **Since** picker adds **All time (archived)**, which lists every archived spin episode,
including sessions whose transcripts are gone (Claude Code deletes transcripts after about 30
days); those cards say so and show the archived trail instead. A small **Spin** counter in the
header, visible on every tab, counts unacknowledged spin findings from the last 24 hours and opens
the brief filtered to spin. Spin settings sit under **Rule controls** next to the per-rule
checkboxes.

### Spin watch

Spin watch detects coding agents that are churning or spinning. Churn in long agent sessions is
often review-round treadmills and merge-gate ceremony made of commands that *succeed*, so failures
are not the signal. The scorer looks at the last ~120 actions and combines five signals, each
ranked against reference distributions that ship in `lib/spin-reference.json` (so every live score
uses the same 0–1 scale):

- share of commands that are process ceremony (re-merging or rebasing on main, polling CI checks,
  regenerating files, lint-fix loops, review and receipt bookkeeping);
- few new files touched;
- the highest “round N” / “pass N” mentioned;
- waiting and polling per action; and
- near-repeat commands (the same command with only numbers, paths, or ids changed).

The equal-weight mean is smoothed over the last three readings. **Watch** starts at 0.70 and
**alert** at 0.85. Two extra rules apply: a review round of 40 or more is an alert (20 or more is a
watch), and the same command five or more times back-to-back is an alert (repeated polling is
reported as waiting instead). Claude Code is less calibrated and is capped at watch by default.
The thresholds and reference distributions were calibrated on the author's own transcripts, so
treat a finding as a prompt to look, not proof; recalibrate on your own hand-labeled sessions with
`scripts/spin-calibrate.js` (and rebuild the reference with `scripts/spin-reference.js`).

**The sensor is an optional hook.** `bin/spin-hook.js` runs after each tool call
(PostToolUse) inside Codex and Claude Code, even when burnboard is closed. It reads only the bytes
appended to the transcript since its last run (on a first call into a very large transcript it
starts from the last ~8 MB), always exits successfully, prints nothing unless it is nudging the
agent, and logs its own errors to `~/.local/state/burnboard/spin/hook-errors.log`. Typical runs take
50–70 ms. It never blocks or stops an agent.

It keeps its state under `~/.local/state/burnboard/spin/`:

- `sessions/` — a small per-session state file (byte offset, the last ~200 compact actions,
  recent readings, last-notified levels);
- `events.jsonl` — an append-only log of level changes, callouts, toasts, and nudges; and
- `episodes/` — the durable **episode archive**: one file per session with ids, repository,
  title or first request, parent/root ids, start/peak/end times, peak score and level, reasons,
  score history, a capped trail of ~120 actions (time, operation, command skeleton, outcome or first
  error line, file), nearby human messages (truncated), and the outcome. No full outputs are kept.

Your own callouts (“churning”, “spinning your wheels”, “going in circles”, “over and over”) are
detected in your messages and recorded on the episode, which labels it “you called it out”.
Instructions such as “keep churn to a minimum”, “PR churn”, and UI spinners are ignored. A callout
with no episode is recorded as a **miss**. If you keep your own hand labels in
`~/.local/state/burnboard/spin/seed-labels.json` (or point `BURNBOARD_SPIN_SEED_LABELS` at a file),
the backfill attaches them, with their notes, to the matching archived sessions; the calibration
script reads the same file. Nothing is seeded without it.

#### Installing the hook

Installing changes your Claude Code and Codex configuration, so it is a separate, explicit step.
Run these from the burnboard checkout you will keep using; the hook entry records that checkout's
path.

1. **Preview and install the hook.**

   ```bash
   node scripts/spin-install.js          # shows exactly what would change
   node scripts/spin-install.js --yes    # backs up, writes, and validates
   ```

   The installer makes a timestamped backup of `~/.claude/settings.json` and
   `~/.codex/hooks.json`, adds one `PostToolUse` entry to each that runs the hook (5-second
   timeout), keeps every existing entry (including `rtk hook` `PreToolUse` entries), and re-reads
   both files to validate them. It never edits `~/.codex/config.toml`.

2. **Approve the hook in Codex.** Codex runs a new or changed hook only after you trust it. Start
   Codex in a terminal:

   ```bash
   codex
   ```

   It reports that a hook is new and needs review (“Hooks can run outside the sandbox after you
   trust them”). Choose **Trust all and continue**, then type `/quit`; no task is needed. Do this
   in a terminal even if you normally use Codex inside an editor (Zed, VS Code and similar):
   editor integrations run Codex in the background, where it cannot show the review prompt, so the
   hook would stay silently off. The approval is saved in `~/.codex/config.toml` and applies
   everywhere Codex runs.

3. **Restart agents that were already running.** Codex reads its hooks when it starts, so restart
   Codex, or the editor that hosts it, after approving. Claude Code normally picks up the new hook
   in open sessions; restart any session where it doesn't fire.

4. **Score your history** (optional, re-runnable) so the brief has past episodes from the start:

   ```bash
   node scripts/spin-backfill.js
   ```

5. **Start the dashboard** from the same checkout and open the brief:

   ```bash
   node server.js            # -> http://localhost:4317
   ```

   The hook keeps scoring and archiving while the dashboard is closed; the dashboard is only needed
   to view the results.

6. **Check that it works.** After an agent's next tool call, its state file appears or updates
   under `~/.local/state/burnboard/spin/sessions/`, and `hook-errors.log` in the same folder stays
   quiet.

**Moving or upgrading.** The hook entry records the absolute paths of this checkout and of the
Node binary. After moving or re-cloning burnboard, or upgrading Node, uninstall and reinstall from
the new location, then approve the changed hook in Codex again (step 2) and restart Codex (step 3):

```bash
node scripts/spin-uninstall.js --yes && node scripts/spin-install.js --yes
```

`node scripts/spin-uninstall.js --yes` on its own removes only the spin entries. Both scripts accept
`--claude-settings`, `--codex-hooks`, `--hook`, and `--only claude|codex`.

#### Settings

`~/.config/burnboard/spin.json` is created with these defaults on first use. Edit it directly or
under **Rule controls → Spin watch settings** in the brief; the hook reads it on every run.

```json
{
  "enabled": true,
  "desktop": { "enabled": true, "minLevel": "alert", "cooldownMinutes": 60 },
  "agentNudge": { "mode": "shadow", "minLevel": "alert" },
  "thresholds": { "watch": 0.70, "alert": 0.85, "reviewRoundWatch": 20, "reviewRoundAlert": 40, "backToBackRepeat": 5 },
  "claudeMaxLevel": "watch",
  "ceremonyPatterns": ["git merge[^|;&]*origin/(main|master)", "gh pr (view|checks)", "codegen", "…"],
  "gatePatterns": ["pre-?merge", "ci:\\w+", "verify\\w*", "…"],
  "mergePatterns": ["\\bgh pr merge\\b", "\\bglab mr merge\\b"],
  "reviewHelperPatterns": ["review", "audit", "critic", "…"],
  "sources": { "codex": true, "claude": true },
  "episodes": { "retentionDays": null },
  "dashboardUrl": "http://localhost:4317"
}
```

- **Desktop notifications** are optional. With `desktop.enabled`, a level rising to `minLevel`
  shows one Windows toast (through the built-in Windows notification API; nothing to install) naming
  the tool, repository, session title, level, and top reasons. Clicking it opens the brief filtered
  to spin. Each session notifies only on upward changes and at most once per cooldown.
- **Agent nudge** is `off`, `shadow` (log the message it would send, the default), or `nudge`. In
  nudge mode the hook adds this context once per level per session: “Spin check: *reasons*. Pause
  and post to the user: the original goal, what is concretely left, and whether another round/gate
  is worth it. Continue only if you can justify it.”
- The pattern lists are regular expressions with project-neutral defaults; each list you set
  replaces the default list, so add your own project's command names there. `ceremonyPatterns`
  mark process-ceremony commands, `gatePatterns` name heavy gate scripts (a package, node or shell
  invocation of one counts as a gate run), `mergePatterns` mark a successful merge, and
  `reviewHelperPatterns` mark helper (subagent) names whose numbers count as review rounds.
- `episodes.retentionDays` keeps archived episodes forever when `null`.

#### Scorer versions and rescoring

Every scorer state, archived episode and backfill manifest entry records the **scorer version**
that produced it: a short hash of `lib/spin.js`, `lib/spin-reference.json` and the scoring settings
(`thresholds`, the four pattern lists, `claudeMaxLevel`). Notification, nudge, source, retention and
UI changes do not change it; neither do comment-only edits or line endings.

Nothing is rescored at server start or when the brief loads; the dashboard only reads the archive.
Re-running the backfill skips unchanged transcripts (same size, mtime and version) and transcripts
the hook has already consumed, scores grown transcripts incrementally from their stored state, and
rescores in full only transcripts scored by an earlier version (or rewritten, or never seen). When
the version changes, the brief says how many threads are waiting and offers **Rescore now**, which
runs one background backfill with a progress bar. Episodes whose transcripts are gone keep their
original version and are marked as scored by an earlier version; episodes a rescore no longer
finds are kept and marked superseded rather than deleted. `--force` rescores everything.

### Worktrees

The **Worktrees** tab groups indexed sessions into repository and recorded-working-directory lanes.
Full paths remain available, while compact labels keep large groups readable and collapsible.
Worktree-shaped paths are identified only as path observations—Burnboard does not claim that a
directory is registered with Git.

Recorded parent/child identifiers produce solid explicit relationships. Sessions grouped only by
repository or working directory use a dashed inferred relationship and explain that basis.
Recorded intervals are labeled parallel, sequential, or unclassified; running, idle, ended, and
unknown states retain their last-seen time.

When two overlapping sessions record edits to the same repository-relative path, Burnboard shows
an **observed edit overlap** with links to both sources. That is coordination evidence, not proof of
a merge conflict.

### Outcome and verification trail

Each Investigate session separates the first recorded request, observed changes, completion-like
claims, command results, validation, commit commands, integration commands, and delivery commands.
A successful command, successful test, agent claim, commit attempt, merge attempt, and deployment
attempt remain independent states. Absence of a recorded error never becomes success.

Validation shows its command, recorded scope, result time, revision or working-state identity when
available, and whether subsequent edits made it historical for the current recorded state. The
present filesystem is never substituted for a missing historical snapshot. A developer can add an
**Accepted**, **Needs work**, **Abandoned**, or **Unknown** assessment and a note; this human outcome
remains separate from agent claims and automated checks.

### Deterministic-analysis coverage

Release Two analyzes at most the newest 300 indexed sessions and the newest 5,000 events per
session while retaining its first request. Findings are capped at 250, observed overlaps at 200,
and each outcome category at 200 records. The API reports analyzed, returned, matched, truncated,
and omitted counts, while the UI surfaces the relevant archive and finding limits rather than
silently implying complete coverage.

Spin watch findings are different: they come from the spin watch episode archive, not from this
analysis, so they are not limited by these session, event, or finding caps, and they remain
available after a transcript is deleted. The overview reports them separately as `spinCoverage`.

The local, loopback-only API is source-read-only; its control endpoint can pause derived indexing
but no route modifies an agent transcript:

- `GET /api/flight/overview` returns the attention brief, findings, worktree lanes, overlaps, and
  coverage;
- `GET /api/flight/session?session=…` returns the bounded outcome and verification trail;
- `GET /api/flight/overview?archive=1` lists every archived spin episode;
- `GET /api/spin/summary` feeds the header indicator, and `GET`/`PUT /api/spin/config` reads and
  validates the spin settings (the only file any of these routes writes); and
- `/api/investigate/*` provides status, sessions, evidence search, original-record inspection, and
  the opt-in Live Monitor stream.

### Reading the charts

Trends, History and the per-command panels share one interaction, so the same two gestures work
everywhere.

**The chart picks *when*.** Every bar is a bucket. Clicking one filters the table below it and
opens the next granularity down, scoped to what you clicked: month → week → day → hour. An hour
is the floor; clicking one filters rather than drilling further. The levels you came through stay
on screen, collapsed, so a sibling bucket is always one click away, with the bar you picked
highlighted. `↺` steps back one level and `clear` returns to everything; both are offered on an
empty slice too, so a stray click is never a dead end.

Bar width follows the bucket count, so three months are readable and ninety days stay narrow.
Below a day, buckets are keyed by the time each *command* ran rather than by session start — but
only as far back as the sources keep per-command timestamps (~24h). Older sub-day ranges fall
back to session start time and say so.

**The table picks *what*.** Clicking a row plots just that command, prompt or invocation in the
charts above, shown as a chip you can clear on its own. The two filters compose: one time slice,
one subject.

Pick a slice the plotted row never ran in and the slice wins: the row filter is dropped and you
land on what actually ran then, rather than on empty charts and empty tables with nothing to say
why. The scope bar names what it let go, so the reset is never silent.

### Activity

Refreshed every 2s over Server-Sent Events.

A **usage bar** at the top shows the account's rate-limit windows (% used / % left of the
weekly limit, time to reset — read from Codex's `rate_limits` in the rollout stream), plus
tokens today / this week and the live total. The weekly % is also mirrored into the header
status line.

One panel *per active agent* (any session written to in the last 15s, or mid-turn). Collapsed
by default so many agents fit on one screen; click the **details** chip — or anywhere on the
header row — to expand.

Subagents show their **lineage** — `spawned by <parent> › <grandparent> › … › this` — walked up
`parent_thread_id` to the root user prompt, each hop clickable. Codex's auto-approval reviewer
appears here as a `guardian` child of the thread whose actions it's vetting.

Collapsed shows: title, age, active-turn flag, a one-line token/ctx/cmd/turn summary,
project · model · effort · tier, the latest message, and the **consumption-over-time chart**
(cumulative tokens as area/line, per-request tokens as stacked bars).

**Clicking a chart opens the timeline at that moment.** The x-position maps back to a timestamp,
and the nearest event is scrolled to and highlighted. An Activity panel has no timeline of its
own, so its chart opens that session's detail panel first; inside the panel the chart stays
pinned to the top, since the first jump would otherwise scroll away the thing you aim the second
one with.

Expanded adds: cwd + full badges, the full **session prompt** and latest message, the token
breakdown (total / ctx window / in / cached / out / reasoning), and two tables —

- **Commands, latest first**: time · command · Δ tokens (consumed after that step) · running total
- **Consumption by base command**: the same commands grouped by base verb with parameters
  stripped (`git status`, `sed`, `apply_patch`, `rg`, …) — runs + summed Δ tokens, biggest first.
  Tallied as commands arrive rather than from the Commands table above it, which is a ring buffer
  capped at the last 300 calls — a long session's rollup would otherwise describe only its tail.
  A `tokens` / `list rate` tab switches the column between token counts and dollars

"% ctx" is the last request's input tokens over the model context window (real occupancy).

**Billed tokens vs. the raw counter.** Codex's `total_token_usage` is per-context-window: it
drops back to ~0 whenever the conversation is compacted, so a long session's raw counter
sawtooths and *undercounts* the total. burnboard instead tracks its own monotonic running sum of
per-request tokens (`last_token_usage`) — that's the "billed tokens" figure and the consumption
chart's line. Compaction points are marked on the chart with a dashed rule.

**What the bars are made of.** Each bar is one request, stacked over the four disjoint buckets it
is billed in: cache read, cache write, input, output. Cache read — the conversation resent every
turn — is typically 90–99% of the total, which is why an unstacked bar looked much the same turn
after turn: it was really plotting how large the conversation had grown, which the line already
says. It sits muted at the base so the buckets billed at full rate read against the bar's top
edge. Codex bills no cache creation, so that segment is absent there. Hovering a bar gives the
exact split.

**The x axis counts requests, not clock time.** Each slot is one request, evenly spaced. Agent
sessions are bursty — six idle hours then forty requests in five minutes — and on a time axis the
idle stretch eats the plot while the burst is crushed into a few pixels at the right edge. On a
usage axis the forty requests get forty bars. The end labels still give real start and end times,
and clicking still lands on a real moment: each slot carries its own timestamp, so a click picks
the slot rather than interpolating across a gap the chart no longer draws.

Hovering the prompt line (or a card's `$` command line) pops the **full command history for the
current turn** — every command and follow-up the agent has run since the last `task_started`,
with per-step token deltas.

**Other live sessions** — compact cards for everything else touched in the last 15 min,
subagents nested under their parent, dot = 🟢 running / 🟡 idle.

### History

**Hour / Day / Week / Month** toggle, vendor/model hierarchy and effort filters, subagents optional. A
tokens-per-bucket chart sits above the table and is the date filter — click a bar to scope the
table to it and drill into its hours. Opens on the most recent bucket.

Table of every session in that slice (started, thread, prompt, project, model, kind, billed
tokens, commands) with a totals bar. **Click any column header to sort.** Click a row for the
detail panel: full message/tool/reasoning timeline, the consumption chart, base-command
breakdown, metadata. The panel is titled by thread — a session with no title of its own is named
from the first real line of its prompt, since a hex id says nothing.

### Trends

Consumption aggregated over **hour / day / week / month** buckets (toggle top-right; model and
effort filters; optionally include subagents). Shows grand totals, a tokens-per-bucket bar chart,
and two independent lists:

- **By base command** — every base command with its token total for the current slice, run count,
  and a trend sparkline.
- **By prompt** — the same, keyed by each session's opening prompt (near-duplicates merged).

Click a bar to drill into that bucket; click a row to plot just that command or prompt over time
— e.g. how `sed`'s or `apply_patch`'s consumption has moved week to week. Each list has a filter
box.

### Agents

The same spend cut by *who* spent it, so agent types can be compared on efficiency
rather than volume. One row per group — regroup with the toggle: **agent type**
(source · role · model), **role**, **model**, **effort** or **project**.

Per group: sessions, billed tokens and share, tokens per session, commands, tokens
per command, cache hit rate, reasoning share of model output, tool-output share,
truncation rate, and tokens burned re-running identical commands. Rates are shown
only where there is enough of them to mean something.

Expand a row for:

- **What its commands are for** — every base command mapped to a class
  (poll · read · edit · vcs · build · net · agent · other) and stacked into one bar,
  so "reading costs 35% of my tool budget" is legible at a glance
- **Costliest commands** — calls, Δ tokens, output tokens fed back into context,
  truncation count; click any command to open its trend
- **Reading of this agent type** — the numbers in plain language: what it spends on,
  whether the cache is working, clipped output, repeat-run waste, compactions

### Economy

"Where do the tokens go, and what looks wasteful?" — aggregated over all sessions (All time /
30 days / 7 days; subagents included by default).

**What to change** sits above the evidence: findings derived from the same slice, ranked by what
they actually cost. The unit of cost is the *turn*, not the byte — every tool call resends the
context, so removing one poll is worth far more than trimming what a command prints. Findings
therefore report two currencies and never add them together: turns billed at full context price,
and output carried as cached context for the rest of the session.

Some findings come from the *order* commands ran in rather than their totals — unbroken poll
runs, files read again that the session had already opened, and search-then-read pairs that one
ranged read would replace. Aggregates can say a command cost you N tokens; only the sequence can
say 242 of those calls were consecutive.

Remedies are grounded in what this machine actually has. burnboard detects the local toolchain —
an output-filtering proxy if one is installed, MCP server names, subagent definitions, skills and
plugins, and the Bash hooks in `settings.json` — and only suggests what you can act on. It reads
names, never values, since those files hold credentials. No model is involved: every number is
computed from your own history, so nothing is invented.

**Diving deeper** is optional and never automatic. If an assistant CLI is installed, each finding
offers to have one read the actual commands behind it — you choose which (Claude Code or Codex),
which model, and how hard it should think, and nothing runs until you click. The effort levels
are each CLI's own vocabulary (Claude Code takes `--effort`, Codex a `model_reasoning_effort`
override), so the list changes with the runner; leave it on *default effort* to pass no flag.

It gets a small evidence window, not your history: the twenty commands around a poll run, the
distinct invocations that re-read a file.

The model annotates a finding; it never adds one. It inherits that finding's numbers, cannot
reorder the list, and is given no field to put a figure in — so the ranking stays measured. Any
quantity it states anyway that is absent from the evidence it was shown is flagged in the output
as invented. Its answer is boxed, labelled with the runner and model that wrote it, and carries
what the call cost you.

Each completed result can generate a ready-to-copy fix prompt. Prompt generation is local and
deterministic, so it makes no second assistant call: it packages the measured finding, bounded
command evidence, interpretation and candidate changes with implementation and validation
requirements. If the interpretation contains a flagged unsupported figure, that model-authored
section is omitted and the prompt falls back to the measured, rule-based remedies.

With no assistant installed — or with `--no-ai` — there is nothing to click and nothing missing:
findings are the product, not a teaser for one. Detection is re-taken at startup, every few minutes, and
immediately after a runner fails to launch, so removing one heals itself.

Carried-context figures are exact over the calls that have per-command timestamps — normally all
of them, and the coverage is stated inline either way. The per-turn cost is a per-session average,
which understates polls because they cluster late in a session when the context is largest.

- **Headline cards**: total command-output tokens read back into context, results truncated at
  the output limit, polling/waiting round-trips (empty `write_stdin` / `wait` / bare
  `exec_command`) as a count and % of all tool calls, and redundant re-runs of unchanged
  commands.
- **By command**: which base commands feed the most text back to the model — tokens, calls,
  avg per call, truncation count. Big + frequent = the best places to add `| tail`, `--quiet`,
  `rg` instead of `cat`, or request specific JSON fields. **Click a row** for a plain-language
  note on what the command does, its trend over time (drillable and plottable per invocation,
  as above), its actual invocations with per-invocation output size and truncation, and — for
  `write_stdin` / `wait` — the underlying processes being polled.
- **Biggest single outputs**, **repeated commands**, and **poll-dominated sessions** — each a
  click-through to the session, with a one-line note on what it means.

Output text-token counts are estimated (~4 chars/token) by default. With `--local-tokens`,
package-mapped models use offline tokenization; the Economy view reports each method's coverage.
Neither method verifies the live consumer's tokenizer or establishes billing. Model
reasoning is encrypted in the rollout files, so the "why" behind each step isn't available —
only what ran and what came back.

History, Trends, Agents and Economy share a one-time streaming scan of every session file
(~70s for ~1100 sessions across ~12GB of transcripts; only parses relevant lines), cached to
unencrypted `.cache/rollups/<parser-and-counting-policy-hash>/<session-id-hash>.msgpack`
files and refreshed incrementally after. Only changed sessions are written, with atomic
replacement; failed writes are retried without rescanning unchanged sessions. Corrupt
session files are rescanned independently. The former `.cache/rollups.json` is ignored
and left untouched; the first start after upgrading rebuilds the cache from transcripts.
Binary encoding is not encryption: these files contain local session metadata and command
details, so treat them with the same privacy care as the transcripts. The cache keeps every command's
timestamp, which is what makes sub-day drilling exact over all history — roughly 30MB and 170MB
resident for ~124k commands. Bumping `ROLLUP_VERSION` invalidates it and re-scans once.

## Cost, and what it isn't

The consumption-by-base-command panel has a `tokens` / `list rate` lens, and the per-command
drill-down prices itself. The dollars come from an explicit rate table in `lib/pricing.js` — per
model, per billing class, per million tokens.

**The four classes bill at rates that differ by 50×.** Taking a model's base input price as 1×:
cache read is 0.1× (0.025× on Fable 5.1), uncached input 1×, cache write 1.25× at the default
5-minute TTL (2× at 1h — it costs *more* than sending the tokens uncached, and breaks even on the
second read), and output 5× on an Opus-tier model. OpenAI has no write premium: caching there is
a read discount only. So a raw token count and a dollar figure rank sessions differently — on a
typical session cache read is ~97% of the tokens and ~66% of the cost, while output is 0.3% of
the tokens and 11% of the cost.

**These dollars are not a bill.** Every place they appear says so, and names your live quota
windows when it can see them: a percentage-of-quota window (Claude's `~/.claude.json`, Codex's
`rate_limits`) means the account is on a plan and is not billed per token at all. What the figure
means is *what these tokens would have cost on metered API billing* — useful for ratios, for
comparing commands, and for knowing what an agent would cost if you moved it onto the API. Under
a plan the marginal cost of a token is zero until a window fills, and then the window is the cost,
not money.

**Costs are priced per session, at that session's own model.** A week's window mixes Opus, Sonnet
and Codex sessions; there is no single rate for it. Sessions whose model is missing from the table
are counted and declared (`+ 2 sessions on an unpriced model — not in the total`) rather than
silently dropped, and an unknown model makes the lens say so instead of inventing a number.

**Cache read is excluded from per-command costs.** It is the conversation resent for every
request — shared by the whole session, caused by no single command. The panel reconciles the
difference out loud rather than leaving a gap: *Σ $11.38 across these commands · the session cost
$57.39, the other $46.01 being cache read.*

**On a single command, the unit is cost per call.** A total is unreadable on its own — $11.85 is
neither good nor bad. The command panel gives the per-call cost set against the median command in
the same window, which separates the two ways something gets expensive:

| | |
|---|---|
| `python3` | $0.039/call — **2.5× the median every time it runs**; output is 76% of it |
| `write_stdin` | $0.0091/call — **0.6× the median**; its $214 total is volume: 23,377 calls |
| `TaskOutput` | $0.301/call — **20× the median**; cache write is 100% of it |

Three different problems with three different fixes, none of which a total could tell you apart.

## How it works

Each agent gets its own ingestion module under `lib/sources/` (`codex.js`, `claude.js`) that
knows how to find that tool's session files and parse its line schema. Both emit the same
normalized record shape, so everything downstream — live snapshots, rollups, trends, economy —
is source-agnostic. Each record keeps its raw `source` and gains a canonical parent `vendor`:
Claude/Anthropic model families roll up to `claude`, while GPT, o-series, Codex and auto-review
models roll up to `codex`. The source name is the fallback for model-less or future-model records.

- Incremental tail-read: each file is parsed once, then only newly-appended bytes on each tick
  (the active session file is already >10 MB).
- `source` in `session_meta` is polymorphic — a string for main threads, an object with
  `subagent.thread_spawn` for spawned agents; both are handled.
- `codex-auto-review` turns are tracked as a separate flag, not counted as the primary model.
- Codex tool calls are JS snippets (`tools.exec_command({cmd:"…"})`); `extractCmd()` digs out the
  real shell string (string, array, or template-literal form, plus `apply_patch`).
- Per-command token cost is approximate. For Codex, tokens accrue between a command and the next
  `token_count` event. For Claude Code, one assistant turn's `usage` block covers all of that
  turn's tool calls at once, so the turn's new tokens are split evenly across them. The same even
  split is kept per billing class, so a command can be priced at each class's own rate rather than
  a blended one.
- Per-base-command totals are tallied in `lib/cmdtally.js` as commands arrive, not derived from
  `sum.commands` — that array is a ring buffer holding the last 300 calls, and anything computed
  from it silently covers only the tail of a long session.
- Rates live in one table (`lib/pricing.js`), matched by model-id prefix so dated suffixes
  (`claude-haiku-4-5-20251001`) resolve. An unmatched model returns no rate rather than a guess.

### Codex vs. Claude Code

|  | Codex CLI | Claude Code |
|---|---|---|
| Location | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.claude/projects/<slug>/<id>.jsonl` |
| Token usage | cumulative counters (`total_token_usage` / `last_token_usage`), reconstructed | self-contained `usage` per assistant turn |
| Tool calls | JS snippets (`tools.exec_command({cmd:"…"})`), unwrapped by `extractCmd()` | structured `tool_use` objects, already parsed |
| Base commands | shell verb from the exec string | tool name (`Read`, `Edit`, …), with `Bash` split into its shell verb |
| Subagents | separate rollout file per subagent, linked by `parent_thread_id` | `isSidechain` turns interleaved in the parent file — folded into the parent's totals for now |
| Compaction | detected (counter resets), marked on the chart | not currently detected |
| Economy signals | full (output tokens, truncation, polling, re-runs) | tool-call counts and token totals; the exec-session polling signals don't apply |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | UI |
| `GET /events` | SSE stream of the live snapshot |
| `GET /api/history` | lightweight rollup rows for the History table (all sessions) |
| `GET /api/sessions?date=YYYY-MM-DD` | full session summaries for one day |
| `GET /api/session/:uuid` | full timeline + summary |
| `GET /api/trends?period=month\|week\|day\|hourly\|slot&subagents=0\|1&source=codex\|claude&from=&to=` | aggregated rollups (`{building:true}` while first scan runs) |
| `GET /api/command?base=&period=…&from=&to=` | one command's series, samples and poll targets |
| `GET /api/agents?range=all\|30d\|7d&by=agent\|role\|model\|effort\|project` | per-agent-type spend, efficiency rates and command-class mix |
| `GET /api/economy?range=all\|30d\|7d&subagents=0\|1&source=codex\|claude` | token-economy signals from the same rollups |
| `GET /api/advice?range=&subagents=&model=&effort=&source=&repo=` | findings for the same slice as `/api/economy`, plus the detected toolchain |
| `GET /api/deepen?id=<finding>&runner=claude\|codex&model2=&effort2=` | runs the chosen local assistant over one finding's evidence (opt-in; spends your quota; 403 under `--no-ai`) |
| `GET /api/facets` | hierarchical vendor/model groups plus the effort / repo values the filters offer |
| `GET /api/flight/overview?since=&rules=&archive=1` | attention brief, findings (spin first), lanes, overlaps, coverage |
| `GET /api/spin/summary` | spin findings from the last 24 h for the header indicator |
| `GET` / `PUT /api/spin/config` | spin watch settings (loopback only; `PUT` takes JSON and validates it) |

Every session record carries its raw `source` and canonical `vendor` (`"codex"` or `"claude"`).
The aggregate endpoints accept an optional `source=` parent/vendor filter; omit it for the
combined view, and an optional `repo=` filter.

`repo=` names a top-level checkout. Sessions run in a git worktree report the worktree directory
rather than the repo, so `<repo>/.codex/worktrees/<branch>` is folded back into `<repo>`, and a
checkout whose sessions never reported a remote is matched to the repo name that sessions from
the same directory *did* report. `GET /api/facets` lists the resulting keys, and the History rows
and live threads carry the same value as `repoKey`.

`from=` / `to=` are epoch milliseconds and scope a request to one clicked bar, which is how the
charts drill down: clicking a month asks for its weeks, a week for its days, a day for its hours.
An hour is as fine as the drill goes — clicking one filters rather than opening a further level.
(`slot`, the 5-minute bucket, still backs the live Hour view.) Below a day the buckets are keyed
by the time each *command* ran rather than by session start, which holds for the whole history:
the sources keep per-command timestamps for the life of each transcript. A source that only kept
a recent window would make older ranges fall back to session start and report
`byCommandTime: false`.

## Trademarks

burnboard is an independent, unofficial tool. It is **not affiliated with, endorsed by, or
sponsored by OpenAI or Anthropic**. "OpenAI" and "Codex" are trademarks of OpenAI; "Anthropic"
and "Claude" are trademarks of Anthropic. They are used here only to identify the products this
tool reads data from. The logos shown next to a session are the vendors' own marks (OpenAI's
logomark from OpenAI's GitHub avatar; the Claude mark from claude.ai/favicon.svg), embedded
unmodified apart from colour and used the same way — as a label for whose model ran that prompt,
not as any part of burnboard's own branding.
