'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, parseArgs } = require('../scripts/spin-install');
const { uninstall } = require('../scripts/spin-uninstall');

// Only temp copies are touched: both target paths are always overridden.
function copies(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-spin-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claudeSettings = path.join(dir, 'settings.json'), codexHooks = path.join(dir, 'hooks.json');
  fs.writeFileSync(claudeSettings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } }, null, 2));
  fs.writeFileSync(codexHooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook codex' }] }] } }, null, 2));
  const options = extra => ({ ...parseArgs(['--claude-settings', claudeSettings, '--codex-hooks', codexHooks, '--node', '/usr/bin/node']), ...extra });
  return { dir, claudeSettings, codexHooks, options, read: file => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('install is a dry run unless --yes, then backs up, adds PostToolUse, and preserves rtk PreToolUse', t => {
  const c = copies(t);
  const before = { claude: fs.readFileSync(c.claudeSettings, 'utf8'), codex: fs.readFileSync(c.codexHooks, 'utf8') };
  const logs = [];
  install(c.options({ yes: false }), line => logs.push(line));
  assert.equal(fs.readFileSync(c.claudeSettings, 'utf8'), before.claude);
  assert.equal(fs.readFileSync(c.codexHooks, 'utf8'), before.codex);
  assert.ok(logs.some(line => /Dry run only/.test(line)));
  const results = install(c.options({ yes: true }), () => {});
  assert.ok(results.every(r => r.changed && fs.existsSync(r.backup)));
  const claude = c.read(c.claudeSettings), codex = c.read(c.codexHooks);
  assert.equal(claude.model, 'opus'); assert.deepEqual(claude.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, 'rtk hook codex');
  const ch = claude.hooks.PostToolUse[0].hooks[0], xh = codex.hooks.PostToolUse[0].hooks[0];
  assert.match(ch.command, /^\/usr\/bin\/node .+bin\/spin-hook\.js --source claude$/); assert.equal(ch.timeout, 5);
  assert.match(xh.command, /--source codex$/);
  assert.equal(install(c.options({ yes: true }), () => {}).filter(r => r.changed).length, 0, 'installing twice adds nothing');
  assert.equal(c.read(c.claudeSettings).hooks.PostToolUse.length, 1);
});

test('uninstall removes only the spin entries', t => {
  const c = copies(t);
  const original = { claude: c.read(c.claudeSettings), codex: c.read(c.codexHooks) };
  install(c.options({ yes: true }), () => {});
  const claude = c.read(c.claudeSettings);
  claude.hooks.PostToolUse.push({ matcher: 'Edit', hooks: [{ type: 'command', command: 'other-tool' }] });
  fs.writeFileSync(c.claudeSettings, JSON.stringify(claude));
  uninstall(c.options({ yes: false }), () => {});
  assert.equal(c.read(c.claudeSettings).hooks.PostToolUse.length, 2, 'dry run changes nothing');
  uninstall(c.options({ yes: true }), () => {});
  assert.deepEqual(c.read(c.claudeSettings).hooks.PostToolUse, [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'other-tool' }] }]);
  assert.deepEqual(c.read(c.codexHooks), original.codex);
  assert.deepEqual(c.read(c.claudeSettings).hooks.PreToolUse, original.claude.hooks.PreToolUse);
});

test('install refuses to point at a missing hook', t => {
  const c = copies(t);
  assert.throws(() => install(c.options({ yes: true, hook: path.join(c.dir, 'nope.js') }), () => {}), /hook not found/);
});
