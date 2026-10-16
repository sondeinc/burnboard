'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createInvestigation } = require('../lib/investigation');

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Math.max(1, Number(process.argv[at + 1]) || fallback) : fallback;
}

async function timed(run) {
  const start = performance.now(); const value = await run();
  return { value, ms: +(performance.now() - start).toFixed(1) };
}

(async () => {
  const sessionCount = option('sessions', 50), eventsPerSession = option('events', 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-investigation-benchmark-'));
  const logs = path.join(dir, 'logs'), cacheDir = path.join(dir, 'cache'); fs.mkdirSync(logs);
  const files = [];
  try {
    for (let session = 0; session < sessionCount; session++) {
      const file = path.join(logs, `session-${session}.jsonl`); files.push(file);
      const rows = [{ type: 'session_meta', timestamp: new Date(1700000000000 + session * 1000).toISOString(), payload: { id: `bench-${session}`, cwd: `/repo/.worktrees/bench-${session}`, git: { branch: 'benchmark', repository_url: 'example/burnboard' } } }];
      for (let event = 0; event < eventsPerSession; event++) rows.push({ type: 'response_item', timestamp: new Date(1700000000000 + session * 1000 + event * 10).toISOString(), payload: { type: 'message', role: event % 4 ? 'assistant' : 'user', content: [{ type: 'input_text', text: event === eventsPerSession - 1 ? `fixture needle ${session}` : `recorded event ${session}/${event}` }] } });
      fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    }
    const source = { id: 'codex', root: logs, watching: logs, looksLikeHome: () => true, allSessionFiles: () => files.slice(), recentFiles: () => files.map(fp => ({ fp })), fileId: file => path.basename(file, '.jsonl'), titleFor: () => null };
    const beforeRss = process.memoryUsage().rss;
    const service = createInvestigation({ sources: [source], cacheDir });
    const cold = await timed(() => service.refresh(true));
    const search = await timed(() => service.query({ q: 'fixture needle', limit: 60 }));
    const first = search.value.events[0];
    const navigation = await timed(() => service.getRaw(first.session, first.id));
    fs.appendFileSync(files[0], JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: 'incremental append' } }) + '\n');
    const append = await timed(() => service.refreshLive(true));
    const sourceRecords = sessionCount * (eventsPerSession + 1);
    const result = {
      fixture: { sessions: sessionCount, sourceRecords, indexedEvents: service.status().events },
      milliseconds: { coldIndex: cold.ms, incrementalAppend: append.ms, fullTextSearch: search.ms, openSourceRecord: navigation.ms },
      memory: { rssDeltaMiB: +((process.memoryUsage().rss - beforeRss) / 1048576).toFixed(1) },
      hardware: { cpu: os.cpus()[0] && os.cpus()[0].model, logicalCpus: os.cpus().length, memoryGiB: +(os.totalmem() / 1073741824).toFixed(1), node: process.version, platform: `${os.platform()} ${os.release()}` },
      budgets: { coldIndexMs: 5000, incrementalAppendMs: 500, fullTextSearchMs: 1500, openSourceRecordMs: 250, rssDeltaMiB: 512 },
    };
    console.log(JSON.stringify(result, null, 2));
    const m = result.milliseconds, b = result.budgets;
    if (m.coldIndex > b.coldIndexMs || m.incrementalAppend > b.incrementalAppendMs || m.fullTextSearch > b.fullTextSearchMs || m.openSourceRecord > b.openSourceRecordMs || result.memory.rssDeltaMiB > b.rssDeltaMiB) process.exitCode = 1;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
