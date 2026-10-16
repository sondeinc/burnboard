# Investigation and the Agentic Monitor

Investigation is Burnboard's local flight recorder. It preserves references to the original Codex and Claude Code records while building a disposable, versioned index under `.cache/investigation/v2/`. Source transcripts are opened read-only. Pins, notes, saved searches, monitor preference, and saved investigations live in browser storage instead of the transcripts.

## Agentic monitor

The agentic monitor is optional and off by default. Turn it on from the Investigate header when you want appended records indexed in real time. Burnboard opens one localhost event stream, checks recently active source files, and commits complete records to the index. Turn it off to close the stream and stop continuous scanning. Search, manual refresh, and existing indexed evidence remain available.

Live updates preserve the selected event, event-list scroll offset, inspector scroll offset, keyboard focus, and URL state. The update notice accumulates while reading. `Follow newest events` is a separate explicit choice.

Investigation routes are bound to loopback and reject non-local hosts and cross-origin requests. Deep links identify local index records; they do not transmit or grant remote access to a transcript. Handoff exports are reviewed and editable before they leave the browser.

## Coverage and limits

- Event references use source identity, byte offset, record part, and a source hash. Unicode and CRLF byte positions round-trip to the original record.
- Complete records up to 8 MiB can be inspected. Longer, malformed, partial, replayed, stale, and unavailable records remain visible as coverage states.
- Search previews are bounded, but matching checks the full source record when a preview was shortened. Results are paged in groups of at most 100.
- Calls and results are linked only by recorded identifiers. A call-to-result interval appears only when both timestamps support it.
- The timeline offers clock time and an explicitly labeled idle-compressed view. Missing timestamps remain missing.
- Indexing can be paused. An explicit refresh resumes it.

## Reproducible performance fixture

Run:

```bash
npm run benchmark:investigation
```

The fixture creates 50 isolated transcripts with 10,050 source records, searches one match per session, opens a source record, appends one event, and removes the fixture afterward. The command fails when a budget is exceeded.

Release One budgets on this fixture are 5,000 ms cold index, 500 ms incremental append, 1,500 ms full-text search, 250 ms source-record navigation, and 512 MiB additional RSS. Record the current command output below when parser or index behavior changes.

Recorded on 2026-10-16 using Node 24.18.0 under WSL2 on a 13th Gen Intel Core i7-13700KF (24 logical CPUs, 47 GiB visible memory): 529.4 ms cold index, 3.1 ms incremental append, 36.8 ms search, 1.2 ms source-record navigation, and 11.2 MiB additional RSS.

## Local API

- `GET /api/investigate/status` — source and index coverage
- `GET /api/investigate/sessions` — filtered session identities
- `GET /api/investigate/events` — paged event records
- `GET /api/investigate/search` — local cross-session text search
- `GET /api/investigate/raw` — verified original source record
- `GET /api/investigate/stream` — opt-in local monitor stream
- `POST /api/investigate/cancel` — pause indexing

All read routes are bounded and return JSON except the event stream. The stream performs no model calls, launches no agents, and runs only while at least one explicitly enabled browser client is connected.
