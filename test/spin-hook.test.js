'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { codex, claude, healthyCodex, treadmillCodex } = require('./spin-helpers');

const HOOK = path.resolve(__dirname, '..', 'bin', 'spin-hook.js');
const ID = '019cae6b-6600-7bbb-8ccc-000000000005'; // synthetic UUIDv7 dated 2026-03-02T12:00Z

function sandbox(t, config = { desktop: { enabled: false } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, BURNBOARD_SPIN_STATE: path.join(dir, 'state'), BURNBOARD_SPIN_CONFIG: path.join(dir, 'spin.json'), BURNBOARD_SPIN_POWERSHELL: path.join(dir, 'no-powershell.exe') };
  if (config) fs.writeFileSync(env.BURNBOARD_SPIN_CONFIG, JSON.stringify(config));
  const sessions = path.join(dir, '.codex', 'sessions', '2026', '03', '02');
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-2026-03-02T12-00-00-${ID}.jsonl`);
  const statePath = path.join(env.BURNBOARD_SPIN_STATE, 'sessions', `codex-${ID}.json`);
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const events = () => { try { return fs.readFileSync(path.join(env.BURNBOARD_SPIN_STATE, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  return { dir, env, file, readState, events };
}
const payload = (file, extra = {}) => JSON.stringify({ session_id: ID, turn_id: 'turn-1', transcript_path: file, cwd: '/home/dev/Repos/app', hook_event_name: 'PostToolUse',
  model: 'gpt-5', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok', tool_use_id: 'u1', ...extra });
function hook(env, input, source = 'codex') {
  const started = Date.now();
  const result = spawnSync(process.execPath, [HOOK, '--source', source], { input, env, encoding: 'utf8', timeout: 5000 });
  return { ...result, ms: Date.now() - started };
}
const write = (file, lines, flag = 'w') => fs.writeFileSync(file, lines.join('\n') + '\n', { flag });

test('hook reads only appended bytes, keeps a byte offset, and logs level changes once', t => {
  const s = sandbox(t);
  write(s.file, healthyCodex(ID, 60));
  let r = hook(s.env, payload(s.file));
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  const first = s.readState();
  assert.equal(first.offset, fs.statSync(s.file).size);
  assert.equal(first.n, 60);
  assert.equal(first.cwd, '/home/dev/Repos/app/.worktrees/a/b');
  write(s.file, treadmillCodex(ID, 200).slice(1), 'a');
  fs.appendFileSync(s.file, codex.cmd(99999, 'pnpm run pre-merge').slice(0, 40)); // partial line still being written
  r = hook(s.env, payload(s.file));
  assert.equal(r.status, 0);
  const second = s.readState();
  assert.equal(second.n, 260, 'only the appended, complete lines were scored');
  assert.ok(second.offset < fs.statSync(s.file).size, 'the trailing partial line waits for the next call');
  assert.notEqual(second.level, 'calm');
  const levels = s.events().filter(e => e.type === 'level');
  assert.ok(levels.length >= 1);
  assert.equal(levels[0].threadId, ID); assert.equal(levels[0].source, 'codex'); assert.equal(levels[0].repo, 'app');
  r = hook(s.env, payload(s.file));
  assert.equal(s.readState().n, 260);
  assert.equal(s.events().filter(e => e.type === 'level').length, levels.length, 'no duplicate events without new actions');
  assert.ok(fs.existsSync(path.join(s.env.BURNBOARD_SPIN_STATE, 'episodes', `codex-${ID}.json`)));
});

test('first call into a huge transcript starts from the last ~8 MB at a line boundary but keeps the header', t => {
  const s = sandbox(t);
  const lines = [codex.meta(ID, '/home/dev/Repos/tools'), codex.user(1, 'Finish review round 13 and merge')];
  for (let i = 0; i < 12; i++) lines.push(codex.noise(2 + i, 1 << 20));
  lines.push(...healthyCodex(ID, 40).slice(1));
  write(s.file, lines);
  const r = hook(s.env, payload(s.file));
  assert.equal(r.status, 0);
  const state = s.readState();
  assert.equal(state.tailStart, true);
  assert.ok(state.gapBytes > 4 << 20);
  assert.equal(state.n, 40);
  assert.equal(state.cwd, '/home/dev/Repos/tools');
  assert.equal(state.firstRequest, 'Finish review round 13 and merge');
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
});

test('corrupt lines, bad payloads and missing transcripts never fail the agent', t => {
  const s = sandbox(t);
  write(s.file, [codex.meta(ID), '{"type":"event_msg",broken', 'not json at all', ...healthyCodex(ID, 10).slice(1)]);
  let r = hook(s.env, payload(s.file));
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(s.readState().n, 10);
  assert.equal(s.readState().corrupt, 2, 'both unreadable lines were skipped and counted');
  for (const input of ['', '{{{', JSON.stringify({ session_id: 'nope', transcript_path: '/does/not/exist.jsonl' })]) {
    r = hook(s.env, input);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
});

test('concurrent invocations for one session stay consistent', async t => {
  const s = sandbox(t);
  write(s.file, treadmillCodex(ID, 200));
  const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, '--source', 'codex'], { env: s.env });
    let out = ''; child.stdout.on('data', d => { out += d; });
    child.on('exit', code => resolve({ code, out }));
    child.stdin.end(payload(s.file));
  })));
  assert.ok(runs.every(run => run.code === 0 && run.out === ''));
  const state = s.readState();
  assert.equal(state.n, 200);
  assert.equal(state.offset, fs.statSync(s.file).size);
  const levels = s.events().filter(e => e.type === 'level' && e.from === 'calm');
  assert.equal(levels.length, 1, 'the calm→watch change is logged exactly once');
  assert.ok(!fs.readdirSync(path.join(s.env.BURNBOARD_SPIN_STATE, 'sessions')).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
});

test('nudge mode returns one valid additionalContext payload per level; shadow mode only logs', t => {
  const s = sandbox(t, { desktop: { enabled: false }, agentNudge: { mode: 'nudge', minLevel: 'watch' } });
  write(s.file, treadmillCodex(ID, 200));
  let r = hook(s.env, payload(s.file));
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^Spin check: .+ Pause and post to the user: the original goal, what is concretely left, and whether another round\/gate is worth it\. Continue only if you can justify it\.$/);
  write(s.file, [codex.cmd(9000, 'pnpm run pre-merge')], 'a');
  r = hook(s.env, payload(s.file));
  assert.equal(r.stdout, '', 'at most once per level per session');
  const shadow = sandbox(t, { desktop: { enabled: false } });
  write(shadow.file, treadmillCodex(ID, 200));
  r = hook(shadow.env, payload(shadow.file));
  assert.equal(r.stdout, '');
  assert.equal(shadow.events().filter(e => e.type === 'nudge-shadow').length, shadow.readState().level === 'alert' ? 1 : 0);
});

test('desktop toasts are optional, upward-only, and logged even when PowerShell is unavailable', t => {
  const s = sandbox(t, { desktop: { enabled: true, minLevel: 'watch', cooldownMinutes: 60 } });
  write(s.file, treadmillCodex(ID, 200));
  hook(s.env, payload(s.file));
  const desktop = s.events().filter(e => e.type === 'desktop');
  assert.equal(desktop.length, 1);
  assert.equal(desktop[0].shown, false);
  assert.match(desktop[0].reason, /PowerShell not found/);
  write(s.file, [codex.cmd(9000, 'pnpm run pre-merge')], 'a');
  hook(s.env, payload(s.file));
  assert.equal(s.events().filter(e => e.type === 'desktop').length, 1);
  const off = sandbox(t, { desktop: { enabled: false } });
  write(off.file, treadmillCodex(ID, 200));
  hook(off.env, payload(off.file));
  assert.equal(off.events().filter(e => e.type === 'desktop').length, 0);
});

test('Codex payloads without transcript_path are located by thread id; Claude payloads score their transcript', t => {
  const s = sandbox(t);
  write(s.file, healthyCodex(ID, 45));
  let r = hook(s.env, payload(null, { transcript_path: null }));
  assert.equal(r.status, 0);
  assert.equal(s.readState().n, 45);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.env.BURNBOARD_SPIN_STATE, 'paths.json'), 'utf8'))[ID], s.file);
  const project = path.join(s.dir, '.claude', 'projects', '-home-dev-Repos-app');
  fs.mkdirSync(project, { recursive: true });
  const cfile = path.join(project, '7c1a0000-0000-4000-8000-000000000006.jsonl');
  write(cfile, [claude.user(0, 'Close out the plan review'), claude.bash(1, 'a1', 'pnpm test'), claude.result(2, 'a1', 'Exit code 1\nerror: boom', true)]);
  r = hook(s.env, JSON.stringify({ session_id: '7c1a0000-0000-4000-8000-000000000006', transcript_path: cfile, cwd: '/home/dev/Repos/app', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), 'claude');
  assert.equal(r.status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(s.env.BURNBOARD_SPIN_STATE, 'sessions', 'claude-7c1a0000-0000-4000-8000-000000000006.json'), 'utf8'));
  assert.equal(state.n, 1); assert.equal(state.ring[0].x, 1); assert.equal(state.isRoot, true);
  assert.equal(state.firstRequest, 'Close out the plan review');
});

test('a disabled sensor or source does nothing', t => {
  const s = sandbox(t, { enabled: false });
  write(s.file, treadmillCodex(ID, 200));
  assert.equal(hook(s.env, payload(s.file)).status, 0);
  assert.equal(fs.existsSync(path.join(s.env.BURNBOARD_SPIN_STATE, 'sessions')), false);
  const c = sandbox(t, { sources: { codex: false } });
  write(c.file, treadmillCodex(ID, 200));
  hook(c.env, payload(c.file));
  assert.equal(fs.existsSync(path.join(c.env.BURNBOARD_SPIN_STATE, 'sessions')), false);
});
