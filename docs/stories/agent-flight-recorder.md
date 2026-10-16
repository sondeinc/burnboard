# Burnboard Agent Flight Recorder

Status: Release One implemented locally; Releases Two and Three remain proposed.

## High Level Summary

Burnboard should become the place a developer opens to understand what their agents accomplished, recover the thread of a difficult task, and decide where to intervene. Connect the request, conversation, tools, worktrees, usage, and available verification into one navigable record.

The promise is simple: **Know what happened. Find what matters. Keep moving.**

Today, Burnboard makes agent activity and consumption visible. This epic makes that history useful while doing the next piece of work. A developer can investigate an unexpected result, find an earlier solution, and hand a new agent the evidence it needs to continue. Over time, the developer learns which workflows work for their projects.

Success means developers reach for Burnboard when they lose context, when agents need attention, and before they start solving a familiar problem again. Revenue, pricing, paid tiers, and billing infrastructure are outside this epic.

## User Story

As a developer working with multiple coding agents, models, repositories, and worktrees, I want to explore what my agents did and what evidence they produced, so I can recover context, resolve problems, coordinate work, and improve how I delegate without rereading entire transcripts.

## A Day With Burnboard

### Coming back to the work

You left several agents running. When you return, Burnboard opens to a short account of what changed since your last visit. One session recorded a passing test run. Another is repeating a failed command. A reviewer returned findings, but its parent has no recorded acknowledgement yet. Each item names its repository and worktree, and opens the relevant events.

You select the repeated failure. The investigation timeline opens with the troublesome interval selected. You see the human request, the agent's actions, tool results, and usage on the same clock. The selection reveals that the last few attempts hit the same environment error. You now have enough evidence to fix the environment or redirect the agent.

### Finding the earlier answer

The error looks familiar. You search a phrase from it. Burnboard finds an older session in the same repository and opens the successful command beside its surrounding conversation. You can see what was tried before it, the reported result, and any associated verification.

You pin that passage and the current failure to a handoff. Burnboard produces a concise continuation packet: the goal, current worktree, relevant evidence, attempted approaches, and outstanding checks. You preview it, then copy it into the agent you want to continue the work.

### Understanding what got done

At the end of the task, the agent says it is finished. Burnboard shows an observed patch, a test result for a particular revision, and an associated commit where those links are available. A test result from before the final edit remains visible, but does not count as verification of that later state.

You annotate the session with the outcome and save the useful investigation. Next week, that session becomes the answer to another search. Burnboard has accumulated something worth returning to: the history of how this project actually gets built.

## Product Experience

Extend the existing application around three entry points. Activity gains a return brief and an attention queue. Investigate becomes the shared workspace opened from sessions, charts, findings, search results, and worktrees. Memory makes previous work searchable and supports saved investigations and handoffs. Workflow comparisons follow once outcomes and evidence are sufficiently structured.

History, Trends, Agents, and Economy remain useful entry points into the same evidence. Existing usage and waste findings feed investigations rather than appearing again as disconnected features.

The first useful experience needs no account or assistant call. Existing local logs produce a timeline, searchable records, and a handoff assembled from selected evidence. Optional model analysis adds interpretation after the developer requests it.

### Visual language

Use a timeline resembling a video editor and a performance profiler. The default is real clock time, with an eight-hour window on live investigations. Offer an explicitly labeled compressed view for long idle intervals; retain timestamps and gap indicators so compressed space cannot be mistaken for elapsed time.

Keep one shared selection across the conversation, tool results, usage, and available artifacts. Brushing a period filters the evidence; selecting an event marks its position in every relevant view. A persistent overview keeps orientation during zoom and drill-down. Browser back restores the previous investigation and selection.

Use worktree swimlanes for coordination, stacked bands for observed context composition, and scatterplots for workflow comparisons. Each visual has a readable list or table alternative. Motion communicates an event or transition and respects reduced-motion preferences.

Live arrivals accumulate in an update indicator while someone is reading. Preserve scroll position, selection, expansion state, and keyboard focus. Following the newest event is an explicit mode. Stable views matter more than animation.

### Investigation layout

```text
 Investigate    sonde / codex / memory-allocator    Search history
 Goal: Repair allocator regression                7 new events
 ----------------------------------------------------------------
 Overview   [------------------ selected interval -----------]
 Clock       09:10          09:20          09:30          09:40
 Human       request -------------------- correction
 Main agent    read   edit   test FAIL      read  edit   test PASS
 Reviewer             spawn -------- findings
 Usage       ____/^^^^^^^^^^\______/^^^^^^^^^^^^\____________
 ----------------------------------------------------------------
 Events in selection             | Evidence
 > Test failed                   | Command, result, source event
   Read allocator.ts             | Related file or captured patch
   Applied patch                 | Verification scope and revision
 ----------------------------------------------------------------
 Pin evidence    Save investigation    Preview handoff
```

The overview, lanes, and evidence panel share the same selection. Opening a related session keeps the investigation's time window. On a narrow screen, Events and Evidence become switchable panes while the overview and selected event remain visible. The displayed times and events above illustrate the proposed layout.

## Implementation Stories

### BB FR 01 Inspect the full session record

As a developer, I can inspect a session's recorded events, identities, and source coverage without losing the original details.

Acceptance criteria:

- Session identity includes source, session and parent IDs, agent role, recorded model changes, effort, client version, repository, branch, working directory, and timestamps where present. Missing fields remain missing rather than being guessed.
- An expandable event inspector exposes the original event and its source location. Unknown event types remain inspectable. Recorded text is distinguished from encrypted or unavailable payloads.
- Tool inputs and results are paired by recorded identifiers where available. Unpaired records remain visible, with no fabricated call or duration.
- Stable event references survive refreshes and distinguish events sharing a timestamp. Resumed or replayed records do not accidentally merge distinct events or count known replays twice.
- Source health shows discovered log locations, last ingestion, parsing gaps, and incomplete coverage. Empty results distinguish no matches from an unavailable or incomplete source.
- Annotations and saved selections live separately from source transcripts.

### BB FR 02 Investigate an interval

As a developer, I can select the period where something changed and inspect the related actions without reading the entire session.

Acceptance criteria:

- Timeline lanes cover human messages, agent messages, tool calls and results, related subagents, and recorded usage. Available edits, tests, approvals, compactions, and commits appear as selectable events with evidence links.
- Brushing, zooming, selecting a lane, and selecting an event update the linked evidence panels. Search and filters compose with the time selection and are visible and reversible.
- Tool duration appears only when timestamps or explicit result metadata support it. Unclassified gaps remain gaps; they are not labeled model thinking or human waiting without evidence.
- A local URL restores session, interval, event, and view mode. It grants no access to logs on another machine.
- New events preserve reading position and selection. Follow mode can be toggled without losing the selected investigation.
- Keyboard users can navigate events, change the interval, and open the same evidence available through pointer interactions.

### BB FR 03 Find and carry forward previous work

As a developer, I can find an earlier solution and turn relevant evidence into a useful continuation packet.

Acceptance criteria:

- Local search covers recorded messages, tool inputs and outputs, errors, and available paths and identifiers. Filters include repository, worktree, session, agent, model, event type, and time.
- Results include surrounding text and open an event in Investigate. Search exposes coverage limits and handles long records without freezing the interface.
- A developer can pin events, add notes, name a saved investigation, and reopen it with its evidence references intact.
- A handoff contains the goal, recorded repository and worktree, selected decisions and attempts, relevant commands and results, known blockers, verification evidence, and remaining checks. Missing sections can be edited or omitted.
- Handoff creation works locally from structured fields, excerpts, and developer notes. Optional assistant summaries are labeled and preserve evidence references.
- The developer previews and edits the packet before copying or exporting it. Size limits are visible; omitted evidence is referenced rather than silently lost. Creating a handoff never launches another coding agent.
- Saved searches and explicit saved-view preferences persist locally. Semantic retrieval is a later enhancement to a working text-search experience.

### BB FR 04 Know where attention is needed

As a developer returning to running work, I see the few sessions worth opening first and the evidence that makes them interesting.

Acceptance criteria:

- Activity offers a brief since the last visit or a chosen time, organized by repository and worktree. Directly detected events work without a model summary.
- Initial attention rules cover repeated equivalent failures, repeated commands with equivalent recorded results, long waits with identifiable pending work, and completion claims whose available validation is missing or older than subsequent relevant changes.
- Findings state their trigger, interval, supporting events, severity rationale, and uncertainty. Related events collapse into one finding rather than an alert per retry.
- Repetition is not automatically a defect. Rules account for changed inputs or results and allow acknowledgement, dismissal, snoozing, and per-rule controls.
- Parent and child return relationships use explicit records where available. Without acknowledgement evidence, the UI says no acknowledgement was recorded rather than asserting that a result was ignored.
- Findings open their evidence in Investigate. Observing a finding does not stop an agent, rerun a command, or send an external notification.

### BB FR 05 See agents across worktrees

As a developer coordinating parallel work, I can see which sessions belong together and where recorded activity overlaps.

Acceptance criteria:

- A board groups sessions into repository and working-directory lanes with compact labels and full paths available on demand. It supports primary checkouts, nested layouts, and unknown identity without treating directory names as proof of Git registration.
- Explicit parent and child relationships connect sessions. Inferred links use a distinct style and explain their basis.
- Selecting a session or interval reveals related work, handoffs, and observed file activity. Concurrent edits to the same path are labeled overlap and link to both records; overlap alone does not establish a merge conflict.
- Running, idle, ended, and unknown states reflect the source's precision. Last-seen timestamps remain visible so an inactive feed is not mistaken for a live process.
- A child result can be inspected in its parent's context while retaining both session identities. Sequential, parallel, and unclassified time remain distinguishable.
- Large groups collapse by repository, worktree, or parent. The default view remains readable without manipulating a free-floating graph.

### BB FR 06 Connect activity to verification

As a developer, I can distinguish an agent's completion claim from observed edits, tests, commits, and integrated delivery evidence.

Acceptance criteria:

- An outcome trail connects the request, relevant events, available changes, observed validation, and associated commits. Each connection exposes its evidence and whether the association was recorded or inferred.
- Completion claims, command success, test success, committed changes, merged changes, and deployment evidence are independent states. Absence of an error never establishes task success.
- Validation names its command, scope, result, time, and revision or captured working-state identity when available. Later relevant changes mark earlier validation as historical for the current state; unknown revision coverage remains unknown.
- Git enrichment begins with read-only local information. Historical file state requires retained patches or captured checkpoints; the present worktree cannot stand in for an earlier snapshot.
- Developers can record accepted, needs work, abandoned, or unknown outcomes with notes. Agent claims, human assessments, and automated checks remain distinguishable.
- PR, CI, and deployment integrations are optional follow-on sources. Their absence does not prevent local investigation and handoffs.

### BB FR 07 Explore context growth

As a developer, I can see which recorded material accumulated and investigate repeated context collection or compaction recovery.

Acceptance criteria:

- The context view separates recorded instructions, messages, tool outputs, subagent summaries, and available compaction records. Unclassified material has its own category.
- Stacked bands show observed additions over time. A companion file view distinguishes observed reads, edits, repeated reads, and unknown operations. Both link to source events.
- The UI names its measure: recorded request usage, logged text tokens, estimates, or bytes. It exposes counting method and coverage and does not sum overlapping measures into a fictitious total.
- Compaction markers open surrounding evidence. Repeated reads or corrections after compaction can be investigated without claiming compaction caused them.
- Hidden reasoning, exact attention, full reconstructed request context, and a file's causal contribution are never implied by the visual. Reading activity alone does not establish that content was used, useful, or wasteful.

### BB FR 08 Learn which workflows work

As a developer, I can compare similar work across configurations and decide which changes deserve a controlled experiment.

Acceptance criteria:

- Comparisons can group by task category, repository, model, effort, role, and captured configuration version. Missing historical skill or instruction versions stay unknown; today's file cannot populate yesterday's configuration.
- A scatterplot shows elapsed time against a selected usage measure, with outcome encoded separately. Its table exposes sample count, validation coverage, identifiable human interventions, and missing data.
- Exact per-model usage stays attributed to the recorded model across mixed-model sessions. Vendor aggregates reconcile with their model slices.
- Cohorts disclose filters and task classifications. Suggested categories are editable. Small or poorly matched cohorts produce observations rather than a winning-model ranking.
- Developers can record a workflow change and inspect subsequent comparable work. Observational changes produce hypotheses; controlled evaluation needs a separate, explicit experiment.
- This epic does not automatically rerun commands, replay mutations, or replace the coding model. Repricing old usage does not establish a counterfactual successful run.

### BB FR 09 Let agents retrieve their own history

As a coding agent, I can request a small, relevant piece of Burnboard's record to avoid rediscovery and continue with better context.

Acceptance criteria:

- A local read-only API and MCP adapter expose session search, similar recorded failures, selected evidence, handoff retrieval, attention findings, and available validation for a worktree.
- Responses identify their sources, coverage, and freshness. Text and event limits are explicit, with pagination or references for omitted detail.
- An agent can identify its current session and exclude it or filter its recent retrievals. Calls do not recursively launch analysis; expensive optional interpretation requires a separate developer action.
- Worktree lookup uses recorded identity and available Git enrichment. Ambiguous matches are explicit.
- Retrieved transcript text is untrusted source material. The interface distinguishes quoted records from instructions and offers no arbitrary command execution through retrieval endpoints.
- The developer controls exposed sources. Remote access and external sharing require separate configuration; local retrieval works without cloud services.

## Delivery Sequence

### Release One Recover the Thread

Deliver BB FR 01 through BB FR 03 as one complete workflow: open a session, select an interval, search earlier evidence, and copy a useful handoff. Reuse existing detail views and parser data where practical, enriching the index for required missing records.

The release is ready when a developer can answer what happened, find a relevant earlier passage, and prepare a continuation packet entirely from local data. This is the first moment Burnboard should feel essential.

### Release Two Know Where to Intervene

Deliver BB FR 04 and BB FR 05, plus local verification from BB FR 06. The return brief and worktree board lead directly into Release One's investigation workflow. Close the loop between noticing a problem and acting with enough context.

### Release Three Improve the Next Run

Deliver BB FR 07, BB FR 08, and BB FR 09 after the source index and outcome links support them. Add optional semantic retrieval and external delivery integrations based on observed needs. Developers and their agents now benefit from previous investigations.

## Data and Implementation Boundaries

Preserve original local logs and build a versioned derived index for navigation and search. Extend the existing Codex and Claude sources behind a common event model while retaining source-specific fields and original payload access. Version parser and index changes explicitly; incremental rebuilds must preserve annotations and saved investigations.

Record source, session, and event identities, timestamps, available call relationships, and provenance for derived links. Handle missing or out-of-order results, identical timestamps, truncated records, replayed metadata, resumed sessions, and source rotation. Bound memory and paginate evidence instead of loading whole archives into the browser.

Keep direct observations, derived associations, estimates, human annotations, and optional model interpretations distinguishable. Preserve existing model attribution and usage accounting. Subscription quota, recorded tokens, and list-rate estimates retain their own units and meanings.

Collect historical Git or configuration checkpoints only through an explicitly configured feature. Do not silently scan unrelated repositories, export transcripts, or interpret the current filesystem as a historical record. Local monitoring and deterministic investigation remain usable with assistant analysis disabled.

## Trust and Usability Requirements

Source links and raw detail are part of the experience: important conclusions have a route back to evidence. Developers can see when coverage is incomplete or stale and still inspect what is available.

Local operation is the default. Exports offer preview, source selection, and redaction before leaving the machine. Deep links share navigation state; portable exports share selected evidence. Plain handoffs identify references that require local access on the destination machine.

Color is accompanied by text or shape. Charts support keyboard access or an equivalent table, and all palettes remain usable. Reduced motion, stable scrolling, preserved focus, and explicit follow mode apply across live investigation surfaces.

Before shipping Release One, record reproducible cold-index, incremental-ingestion, search, and navigation measurements on named fixture sizes and test hardware. Define and document performance budgets from those fixtures. A growing archive must not block the visible interface; indexing progress and cancellation remain accessible.

## End to End Acceptance

Use synthetic transcripts and temporary Git repositories to verify these journeys across both sources where their records support them:

1. A developer returns to several sessions, opens a repeated-failure finding, and reaches supporting events without losing the Activity reading position.
2. Search finds an earlier error and its surrounding command and result. The developer pins evidence, previews a bounded handoff, and reopens its event references.
3. Two worktrees on the same branch remain distinct. Concurrent recorded file edits produce an overlap finding with both sources without asserting a conflict.
4. An agent claims completion after tests ran, then edits again. The prior result remains visible but does not verify the later state.
5. A session changes models, spawns a child, and compacts. Usage reconciles, lineage is navigable, and missing context or call timing is represented explicitly.
6. New events arrive during investigation. Selection, focus, expanded detail, and reading position remain stable until the developer enables follow mode.
7. An incomplete log, duplicate replay, unknown event, and unavailable source produce understandable states with access to available evidence.
8. An agent retrieves a bounded handoff with source references without invoking a model, modifying the repository, or re-executing recorded tools.

## How We Know It Is Useful

Measure whether people recover context and make a useful next decision. In usability sessions, observe time to locate a failure's evidence, find an earlier solution, and prepare a usable handoff, along with attention findings dismissed as unhelpful. Compare against the same tasks using raw transcripts or the existing detail view.

Look for voluntary return use: saved investigations reopened, evidence found across sessions, and handoffs successfully used to continue work. Collect product measurements locally by default; external analytics are opt-in. More alerts, graph interactions, or tokens inspected are not success by themselves.

Burnboard earns a permanent place in the developer's day when yesterday's agent work makes today's work easier to understand and continue.
