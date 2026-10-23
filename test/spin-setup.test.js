'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const setup = require('../lib/spin-setup');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-05-04T12:00:00Z');

// A synthetic machine in a temp dir: a burnboard checkout, a Node binary,
// Claude Code and Codex configs, Codex's config.toml, and the spin state dir.
// Nothing outside the temp dir is read or written.
function machine(t, { claude = true, codex = true, approve = 'current', spin = {}, checkout, node, backfill = true, ran = true, errors = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const here = checkout || path.join(dir, 'burnboard');
  fs.mkdirSync(path.join(here, 'bin'), { recursive: true });
  if (!fs.existsSync(path.join(here, 'bin', 'spin-hook.js'))) fs.writeFileSync(path.join(here, 'bin', 'spin-hook.js'), '');
  const nodeBin = node || path.join(dir, 'node');
  if (!node) fs.writeFileSync(nodeBin, '');
  const hookCommand = (source, hookDir = here, bin = nodeBin) => `${bin} ${path.join(hookDir, 'bin', 'spin-hook.js')} --source ${source}`;
  const claudeHome = path.join(dir, 'claude'), codexHome = path.join(dir, 'codex'), stateDir = path.join(dir, 'state');
  for (const d of [claudeHome, codexHome, path.join(stateDir, 'sessions')]) fs.mkdirSync(d, { recursive: true });
  const pre = tool => [{ matcher: 'Bash', hooks: [{ type: 'command', command: `rtk hook ${tool}` }] }];
  const post = command => [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }];
  const claudeSettings = path.join(claudeHome, 'settings.json'), codexHooks = path.join(codexHome, 'hooks.json');
  const codexConfig = path.join(codexHome, 'config.toml'), configFile = path.join(dir, 'spin.json');
  const claudeCmd = typeof claude === 'string' ? claude : hookCommand('claude');
  const codexCmd = typeof codex === 'string' ? codex : hookCommand('codex');
  fs.writeFileSync(claudeSettings, JSON.stringify({ model: 'opus', hooks: { PreToolUse: pre('claude'), ...(claude ? { PostToolUse: post(claudeCmd) } : {}) } }, null, 2));
  const codexFile = { hooks: { PreToolUse: pre('codex'), ...(codex ? { PostToolUse: post(codexCmd) } : {}) } };
  fs.writeFileSync(codexHooks, JSON.stringify(codexFile, null, 2));
  const toml = ['model = "example"', '', '[hooks.state]', ''];
  const approveEntry = (event, label, hash) => toml.push(`[hooks.state."${codexHooks}:${label}:0:0"]`, `trusted_hash = "${hash}"`, '');
  approveEntry('PreToolUse', 'pre_tool_use', setup.codexHookHash('PreToolUse', codexFile.hooks.PreToolUse[0], codexFile.hooks.PreToolUse[0].hooks[0]));
  if (codex && approve === 'current') approveEntry('PostToolUse', 'post_tool_use', setup.codexHookHash('PostToolUse', codexFile.hooks.PostToolUse[0], codexFile.hooks.PostToolUse[0].hooks[0]));
  if (codex && approve === 'stale') approveEntry('PostToolUse', 'post_tool_use', 'sha256:' + '0'.repeat(64));
  fs.writeFileSync(codexConfig, toml.join('\n'));
  fs.writeFileSync(configFile, JSON.stringify({ agentNudge: { mode: 'nudge', minLevel: 'alert' }, claudeMaxLevel: 'alert', ...spin }));
  if (backfill) fs.writeFileSync(path.join(stateDir, 'backfill-progress.json'), JSON.stringify({ pid: 1, startedAt: NOW - 7200000, updatedAt: NOW - 7000000, finishedAt: NOW - 7000000 }));
  if (ran) { const f = path.join(stateDir, 'sessions', 'codex-t1.json'); fs.writeFileSync(f, '{}'); fs.utimesSync(f, new Date(NOW - 120000), new Date(NOW - 120000)); }
  if (errors.length) fs.writeFileSync(path.join(stateDir, 'hook-errors.log'), errors.map(([at, msg]) => `${new Date(at).toISOString()} hook ${msg}\n    at somewhere (file.js:1:1)\n`).join(''));
  const overrides = { claudeSettings, codexHooks, codexConfig, stateDir, configFile, claudeHome, codexHome, checkoutDir: here, now: NOW };
  const env = { ...process.env, BURNBOARD_CLAUDE_SETTINGS: claudeSettings, BURNBOARD_CODEX_HOOKS: codexHooks, BURNBOARD_CODEX_CONFIG: codexConfig,
    BURNBOARD_SPIN_STATE: stateDir, BURNBOARD_SPIN_CONFIG: configFile, CODEX_HOME: codexHome };
  return { dir, here, nodeBin, claudeSettings, codexHooks, codexConfig, configFile, stateDir, overrides, env, hookCommand,
    check: extra => setup.check({ ...overrides, ...extra }), read: file => fs.readFileSync(file, 'utf8') };
}
const item = (status, id) => status.items.find(i => i.id === id);
const steps = status => status.nextSteps.map(s => s.id);

test('Codex trust hash matches the scheme Codex uses (normalized, key-sorted compact JSON)', () => {
  const group = { matcher: 'Bash', hooks: [{ type: 'command', command: 'example-tool hook' }] };
  // Defaults filled in: timeout 600, async false; keys sorted; event as snake_case.
  const expected = 'sha256:' + require('node:crypto').createHash('sha256')
    .update('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"example-tool hook","timeout":600,"type":"command"}],"matcher":"Bash"}').digest('hex');
  assert.equal(setup.codexHookHash('PreToolUse', group, group.hooks[0]), expected);
  assert.notEqual(setup.codexHookHash('PostToolUse', group, group.hooks[0]), expected);
  const states = setup.readHookStates('[hooks.state]\n"/x/hooks.json:stop:0:0" = { trusted_hash = "sha256:aa" }\n[hooks.state."/x/hooks.json:post_tool_use:1:0"]\ntrusted_hash = "sha256:bb"\nenabled = false\n[other]\ntrusted_hash = "sha256:cc"\n');
  assert.deepEqual(Object.fromEntries(states), { '/x/hooks.json:stop:0:0': { trustedHash: 'sha256:aa' }, '/x/hooks.json:post_tool_use:1:0': { trustedHash: 'sha256:bb', enabled: false } });
  assert.deepEqual(setup.splitCommand('"/opt/my node/bin/node" /srv/app/bin/spin-hook.js --source codex'), ['/opt/my node/bin/node', '/srv/app/bin/spin-hook.js', '--source', 'codex']);
});

test('all good: a single ready line with the nudge mode, and nothing missing', t => {
  const m = machine(t);
  const status = m.check();
  assert.equal(status.ready, true, status.text);
  assert.equal(status.missing, false);
  assert.deepEqual(status.nextSteps, []);
  assert.equal(item(status, 'codex-approval').state, 'approved');
  assert.equal(status.text, 'Spin watch: ready · nudge mode: nudge (agents are told when they spin)');
});

test('hooks missing: ✗ for both, install / approve / restart steps in order, and a repair plan', t => {
  const m = machine(t, { claude: false, codex: false });
  const status = m.check();
  assert.equal(status.missing, true);
  assert.equal(item(status, 'claude-hook').status, 'missing');
  assert.equal(item(status, 'codex-hook').status, 'missing');
  assert.deepEqual(steps(status), ['install', 'approve', 'restart']);
  assert.deepEqual(status.repair, [{ tool: 'claude', action: 'install' }, { tool: 'codex', action: 'install' }]);
  assert.match(status.text, /✗ Claude Code hook: not installed/);
  assert.match(status.text, /node scripts\/spin-install\.js --yes/);
  assert.match(status.text, /Trust all and continue/);
  assert.match(status.text, /Zed can't show the approval prompt/);
});

test('a tool that is not on this computer is skipped, not reported missing', t => {
  const m = machine(t, { claude: false });
  fs.rmSync(path.dirname(m.claudeSettings), { recursive: true });
  const status = m.check();
  assert.equal(item(status, 'claude-hook').skipped, true);
  assert.equal(status.missing, false);
});

test('hook pointing to another checkout, or to a Node that is gone: ✗ and the reinstall command', t => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-other-checkout-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.mkdirSync(path.join(elsewhere, 'bin')); fs.writeFileSync(path.join(elsewhere, 'bin', 'spin-hook.js'), '');
  const m = machine(t, { claude: `/usr/local/bin/node-not-here-${process.pid} ${path.join(elsewhere, 'bin', 'spin-hook.js')} --source claude` });
  const status = m.check();
  const claude = item(status, 'claude-hook');
  assert.equal(claude.status, 'missing');
  assert.equal(claude.thisCheckout, false);
  assert.equal(claude.nodeExists, false);
  assert.match(claude.text, /another checkout/);
  assert.match(claude.text, /Node binary .* no longer exists/);
  assert.equal(item(status, 'codex-hook').status, 'ok');
  assert.deepEqual(steps(status), ['reinstall', 'restart']);
  assert.match(status.text, /spin-uninstall\.js --yes && node scripts\/spin-install\.js --yes/);
  assert.deepEqual(status.repair, [{ tool: 'claude', action: 'reinstall' }]);
});

test('Node path missing alone is enough to need a reinstall', t => {
  const m = machine(t);
  fs.rmSync(m.nodeBin);
  const status = m.check();
  assert.equal(item(status, 'claude-hook').status, 'missing');
  assert.match(item(status, 'codex-hook').text, /Node binary .* no longer exists/);
  assert.deepEqual(steps(status), ['reinstall', 'approve', 'restart']);
});

test('Codex approval: not approved, approved, and changed since approval', t => {
  const none = machine(t, { approve: 'none' }).check();
  assert.equal(item(none, 'codex-approval').state, 'not-approved');
  assert.equal(item(none, 'codex-approval').status, 'missing');
  assert.equal(none.missing, true);
  assert.deepEqual(steps(none), ['approve', 'restart']);
  assert.match(none.text, /✗ Codex approval: not approved yet/);

  const approved = machine(t, { approve: 'current' }).check();
  assert.equal(item(approved, 'codex-approval').state, 'approved');
  assert.equal(item(approved, 'codex-approval').hashVerified, true);

  // A different hash, with the scheme confirmed on the rtk PreToolUse approval.
  const stale = machine(t, { approve: 'stale' }).check();
  assert.equal(item(stale, 'codex-approval').state, 'changed');
  assert.deepEqual(steps(stale), ['approve', 'restart']);

  // Without any approval the scheme can be confirmed on, it only says "found".
  const m = machine(t, { approve: 'stale' });
  fs.writeFileSync(m.codexConfig, m.read(m.codexConfig).replace(/\[hooks\.state\."[^"]*pre_tool_use:0:0"\]\ntrusted_hash = "[^"]*"\n/, ''));
  const unsure = m.check();
  assert.equal(item(unsure, 'codex-approval').state, 'found');
  assert.equal(item(unsure, 'codex-approval').status, 'warn');
});

test('the impossible-nudge warning names the setting to change', t => {
  const status = machine(t, { spin: { claudeMaxLevel: 'watch', agentNudge: { mode: 'nudge', minLevel: 'alert' }, desktop: { enabled: false } } }).check();
  const s = item(status, 'settings');
  assert.equal(s.status, 'warn');
  assert.deepEqual(s.impossible, ['nudge']);
  assert.match(status.text, /! Settings:/);
  assert.match(status.text, /Claude Code threads can never be nudged: Claude is capped at watch \(claudeMaxLevel\) but nudges start at alert/);
  assert.match(status.text, /"Claude Code at most" to alert/);
  assert.equal(status.missing, false, 'a settings warning is not a missing step');
  const fine = machine(t, { spin: { claudeMaxLevel: 'watch', agentNudge: { mode: 'nudge', minLevel: 'watch' }, desktop: { enabled: false } } }).check();
  assert.deepEqual(item(fine, 'settings').impossible, []);
});

test('shadow mode: says nudges are only logged and where to switch them on', t => {
  const ready = machine(t, { spin: { agentNudge: { mode: 'shadow', minLevel: 'alert' } } }).check();
  assert.equal(ready.ready, true);
  assert.match(ready.text, /^Spin watch: ready · nudge mode: shadow \(nudges are only logged; switch them on in Attention Brief → Rule controls → Spin watch settings\)$/);
  const busy = machine(t, { approve: 'none', spin: { agentNudge: { mode: 'shadow', minLevel: 'alert' } } }).check();
  assert.match(busy.text, /Nudges are only logged \(shadow mode\)/);
  assert.deepEqual(steps(busy), ['approve', 'restart', 'nudge']);
  assert.ok(busy.text.split('\n').length <= 15, busy.text);
});

test('activity and archive: never ran, recent errors, backfill never run, rescore pending', t => {
  const m = machine(t, { ran: false, backfill: false, errors: [[NOW - 3600000, 'ReferenceError: example is not defined']] });
  const status = m.check();
  assert.equal(item(status, 'activity').status, 'warn');
  assert.match(item(status, 'activity').text, /has not run yet.*1 error in the last day.*ReferenceError: example is not defined/);
  assert.equal(item(status, 'archive').backfillRan, false);
  assert.ok(steps(status).includes('backfill'));
  // Errors followed by a clean run are history, not a problem.
  const later = machine(t, { errors: [[NOW - 3600000, 'Error: old']] }).check();
  assert.equal(item(later, 'activity').status, 'ok');
  assert.match(item(later, 'activity').text, /no errors since \(1 earlier/);
  // A thread scored by an earlier scorer version is a pending rescore.
  const r = machine(t);
  const transcript = path.join(r.dir, 'rollout.jsonl'); fs.writeFileSync(transcript, '{}\n');
  fs.writeFileSync(path.join(r.stateDir, 'backfill-manifest.json'), JSON.stringify({ v: 2, files: { [transcript]: { size: 3, mtimeMs: 1, scorer: 's1-older' } } }));
  const pending = r.check();
  assert.equal(item(pending, 'archive').pendingThreads, 1);
  assert.match(item(pending, 'archive').text, /1 session needs a rescore/);
  assert.deepEqual(steps(pending), ['backfill']);
});

test('non-TTY start prints the block without prompting', async t => {
  const m = machine(t, { claude: false, codex: false });
  const lines = [];
  const input = new PassThrough(), output = new PassThrough();
  const result = await setup.startup({ input, output, log: line => lines.push(line), overrides: m.overrides });
  assert.equal(result.asked, false);
  assert.equal(lines[0], 'Spin watch');
  assert.ok(lines.some(line => /Next steps/.test(line)));
  assert.equal(output.read(), null, 'nothing was asked');
  assert.doesNotMatch(m.read(m.claudeSettings), /spin-hook/);
});

test('terminal offer: default No changes nothing; "y" installs and repairs with backups', async t => {
  const m = machine(t, { claude: false, codex: `/no/such/node ${path.join(os.tmpdir(), 'gone-checkout', 'bin', 'spin-hook.js')} --source codex` });
  const before = { claude: m.read(m.claudeSettings), codex: m.read(m.codexHooks), toml: m.read(m.codexConfig) };
  const ask = async answer => {
    const input = new PassThrough(), output = new PassThrough(), lines = [];
    output.on('data', () => {});
    const done = setup.startup({ input, output, interactive: true, log: line => lines.push(line), overrides: m.overrides });
    setImmediate(() => input.write(answer + '\n'));
    return { result: await done, lines };
  };
  const no = await ask('');
  assert.equal(no.result.asked, true);
  assert.deepEqual(no.result.installed, []);
  assert.equal(m.read(m.claudeSettings), before.claude);
  assert.equal(m.read(m.codexHooks), before.codex);

  const yes = await ask('y');
  assert.deepEqual(yes.result.installed, ['claude', 'codex']);
  const claude = JSON.parse(m.read(m.claudeSettings)), codex = JSON.parse(m.read(m.codexHooks));
  assert.equal(claude.model, 'opus');
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
  assert.match(claude.hooks.PostToolUse[0].hooks[0].command, new RegExp(`${path.join(m.here, 'bin', 'spin-hook.js').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} --source claude$`));
  assert.equal(codex.hooks.PostToolUse.length, 1, 'the stale entry was replaced, not duplicated');
  assert.ok(codex.hooks.PostToolUse[0].hooks[0].command.includes(path.join(m.here, 'bin', 'spin-hook.js')));
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, 'rtk hook codex');
  assert.ok(fs.readdirSync(path.dirname(m.codexHooks)).some(name => name.includes('.bak-spin-')), 'backup written');
  assert.ok(yes.lines.some(line => /Trust all and continue/.test(line)));
  assert.ok(yes.lines.some(line => /restart Codex/i.test(line)));
  assert.equal(m.read(m.codexConfig), before.toml, 'config.toml is never written');
  const after = m.check();
  assert.equal(item(after, 'claude-hook').status, 'ok');
  assert.equal(item(after, 'codex-hook').status, 'ok');
  assert.equal(item(after, 'codex-approval').state, 'changed', 'the old approval no longer matches the new entry');
});

test('--spin-check-only prints the status and exits 0 when nothing is missing, 1 otherwise', t => {
  const good = machine(t, { checkout: ROOT, node: process.execPath });
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'server.js'), '--spin-check-only'], { env: good.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^Spin watch: ready/);
  const bad = machine(t, { checkout: ROOT, node: process.execPath, approve: 'none' });
  const missing = spawnSync(process.execPath, [path.join(ROOT, 'server.js'), '--spin-check-only'], { env: bad.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /✗ Codex approval: not approved yet/);
  assert.match(missing.stdout, /Next steps\n {2}1\. Approve the hook in Codex/);
  assert.doesNotMatch(missing.stdout, /localhost:\d+/, 'the server did not start');
});

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
  });
}

test('GET /api/spin/setup returns the same status; the server prints it on start without prompting', { timeout: 30000 }, async t => {
  const m = machine(t, { approve: 'none', node: process.execPath });
  const copy = path.join(m.dir, 'app');
  for (const name of ['server.js', 'index.html', 'lib', 'bin', 'scripts']) fs.cpSync(path.join(ROOT, name), path.join(copy, name), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Point the synthetic hooks at the copied checkout.
  for (const file of [m.claudeSettings, m.codexHooks]) fs.writeFileSync(file, m.read(file).split(m.here).join(copy));
  const codexRoot = path.join(m.dir, 'codex'), claudeRoot = path.join(m.dir, 'claude');
  fs.mkdirSync(path.join(codexRoot, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(claudeRoot, 'projects'), { recursive: true });
  const child = spawn(process.execPath, [path.join(copy, 'server.js'), '--no-ai', '--port', '0', '--root', codexRoot, '--claude-root', claudeRoot], { env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let logs = '';
  t.after(async () => { child.kill(); await exited; });
  const base = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { logs += data; const found = logs.match(/http:\/\/localhost:(\d+)/); if (found) resolve(`http://127.0.0.1:${found[1]}`); });
    child.stderr.on('data', data => { logs += data; });
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${logs}`)));
  });
  const response = await request(base + '/api/spin/setup');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  for (const key of ['checkout', 'ready', 'missing', 'nudgeMode', 'items', 'nextSteps', 'repair', 'text', 'files']) assert.ok(key in body, key);
  assert.equal(body.checkout, copy);
  assert.deepEqual(body.items.map(i => i.id), ['claude-hook', 'codex-hook', 'codex-approval', 'activity', 'settings', 'archive']);
  for (const i of body.items) { assert.ok(['ok', 'warn', 'missing'].includes(i.status)); assert.equal(typeof i.text, 'string'); assert.equal(typeof i.label, 'string'); }
  assert.equal(body.missing, true);
  assert.deepEqual(body.nextSteps.map(s => s.id), ['approve', 'restart']);
  assert.match(body.text, /✗ Codex approval/);
  const deadline = Date.now() + 5000;
  while (!/Spin watch/.test(logs) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.match(logs, /✗ Codex approval: not approved yet/);
  assert.doesNotMatch(logs, /\[y\/N\]/, 'no prompt without a terminal');
});

test('the settings form shows the setup status as copyable text', () => {
  const ui = require('../lib/ui/flight-recorder');
  const store = require('../lib/spin-store');
  const form = ui.settingsForm(store.validateConfig({}).config, { archive: {}, hookInstalled: {} }, { text: 'Spin watch\n  ✗ Codex approval: not approved yet <now>' });
  assert.match(form, /<pre class="fr-spin-setup" data-spin-setup>Spin watch\n {2}✗ Codex approval: not approved yet &lt;now&gt;<\/pre>/);
  assert.match(ui.settingsForm(store.validateConfig({}).config, {}), /<pre class="fr-spin-setup" data-spin-setup hidden><\/pre>/);
  assert.doesNotMatch(form, /<button[^>]*>[^<]*[Ii]nstall/);
});
