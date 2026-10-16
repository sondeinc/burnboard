'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function dayParts(date = new Date()) {
  return [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')];
}

async function waitFor(check, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for investigation state');
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('investigation API is local-only and its opt-in stream commits appended events live', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-investigation-server-'));
  const root = path.resolve(__dirname, '..');
  for (const name of ['server.js', 'index.html', 'lib']) fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const codexRoot = path.join(dir, 'codex'), claudeRoot = path.join(dir, 'claude');
  const dateDir = path.join(codexRoot, 'sessions', ...dayParts());
  fs.mkdirSync(dateDir, { recursive: true }); fs.mkdirSync(path.join(claudeRoot, 'projects'), { recursive: true });
  const file = path.join(dateDir, 'rollout-live-11111111-1111-1111-1111-111111111111.jsonl');
  const at = new Date().toISOString();
  const row = text => JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: at, payload: { id: 'live-one', cwd: '/repo/.worktrees/live' } }) + '\n' + row('before monitor') + '\n');
  const child = spawn(process.execPath, [path.join(dir, 'server.js'), '--no-ai', '--port', '0', '--root', codexRoot, '--claude-root', claudeRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let logs = '';
  t.after(async () => {
    child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { logs += data; const found = logs.match(/http:\/\/localhost:(\d+)/); if (found) resolve(`http://127.0.0.1:${found[1]}`); });
    child.stderr.on('data', data => { logs += data; });
    child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}: ${logs}`)));
  });

  const script = await request(base + '/investigate.js');
  assert.equal(script.status, 200);
  assert.match(script.body, /monitor: false/);
  assert.match(script.body, /if \(data\.monitor\) startMonitor\(\)/);
  assert.doesNotMatch(script.body, /Agentic monitor/i);
  assert.match(script.body, /Live Monitor/);
  assert.equal((await request(base + '/flight-recorder.js')).status, 200);
  const wrongOrigin = await request(base + '/api/investigate/status', { Origin: 'http://example.test' });
  assert.equal(wrongOrigin.status, 403);
  const wrongHost = await request(base + '/api/investigate/status', { Host: 'example.test' });
  assert.equal(wrongHost.status, 403);
  assert.equal((await request(base + '/api/flight/overview', { Origin: 'http://example.test' })).status, 403);

  const status = await waitFor(async () => {
    const response = await request(base + '/api/investigate/status');
    const value = JSON.parse(response.body);
    return !value.building && value.sessions === 1 ? value : null;
  });
  const initialEvents = status.events;

  const live = new Promise((resolve, reject) => {
    const req = http.get(base + '/api/investigate/stream', res => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buffer = '', appended = false;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        const frames = buffer.split('\n\n'); buffer = frames.pop();
        for (const frame of frames) {
          const line = frame.split('\n').find(value => value.startsWith('data: '));
          if (!line) continue;
          const value = JSON.parse(line.slice(6));
          if (!appended) { appended = true; fs.appendFileSync(file, row('arrived live') + '\n'); }
          if (value.events > initialEvents) { req.destroy(); resolve(value); }
        }
      });
      res.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    req.on('error', reject);
  });
  const started = Date.now();
  let timeout;
  const updated = await Promise.race([live, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Live event was not indexed')), 6000); })]);
  clearTimeout(timeout);
  assert.equal(updated.events, initialEvents + 1);
  assert.ok(Date.now() - started < 6000, 'the enabled monitor reports the append without a manual refresh');

  const sessions = JSON.parse((await request(base + '/api/investigate/sessions?refresh=0')).body);
  const events = JSON.parse((await request(base + `/api/investigate/events?session=${sessions.sessions[0].key}&refresh=0`)).body);
  assert.ok(events.events.some(event => event.text === 'arrived live'));
  const overview = JSON.parse((await request(base + '/api/flight/overview?refresh=0')).body);
  assert.equal(overview.lanes.length, 1);
  assert.match(overview.lanes[0].reason, /Git registration was not checked/);
  const trail = JSON.parse((await request(base + `/api/flight/session?session=${sessions.sessions[0].key}&refresh=0`)).body);
  assert.equal(trail.request.text, 'before monitor');
  assert.match(trail.coverage, /Current filesystem state was not used/);
});
