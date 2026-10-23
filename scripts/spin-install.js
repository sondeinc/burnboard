#!/usr/bin/env node
'use strict';

// Installs the spin watch PostToolUse hook for Claude Code and Codex.
//
//   node scripts/spin-install.js            # show the planned change only
//   node scripts/spin-install.js --yes      # back up, write, and validate
//
// Options: --claude-settings <file> (default ~/.claude/settings.json),
// --codex-hooks <file> (default ~/.codex/hooks.json), --hook <spin-hook.js>,
// --node <node binary>, --only claude|codex, --claude-timeout <seconds>.
//
// What it changes: one PostToolUse entry per tool that runs the hook. Existing
// entries (including the `rtk hook` PreToolUse entries) are preserved exactly.
// Each file gets a timestamped backup first, and is re-read and validated
// afterwards. Codex's config.toml (and its trusted_hash entries) is never
// touched: Codex asks you to review and trust the new hook on its next start.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = 'spin-hook.js';

function parseArgs(argv) {
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const home = os.homedir();
  return {
    yes: argv.includes('--yes'),
    only: opt('--only', null),
    claudeSettings: opt('--claude-settings', path.join(home, '.claude', 'settings.json')),
    codexHooks: opt('--codex-hooks', path.join(home, '.codex', 'hooks.json')),
    hook: path.resolve(opt('--hook', path.join(__dirname, '..', 'bin', 'spin-hook.js'))),
    node: opt('--node', process.execPath),
    claudeTimeout: Number(opt('--claude-timeout', 5)),
    codexTimeout: Number(opt('--codex-timeout', 5)),
  };
}
const quote = value => /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
const command = (o, source) => `${quote(o.node)} ${quote(o.hook)} --source ${source}`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.spin-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.bak-spin-${stamp()}`;
  fs.copyFileSync(file, copy);
  return copy;
}
const hasSpin = groups => (groups || []).some(group => (group.hooks || []).some(hook => String(hook.command || '').includes(MARKER)));

function planClaude(settings, o) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  next.hooks = next.hooks || {};
  const post = next.hooks.PostToolUse = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];
  if (hasSpin(post)) return { next, changed: false };
  post.push({ matcher: '*', hooks: [{ type: 'command', command: command(o, 'claude'), timeout: o.claudeTimeout }] });
  return { next, changed: true };
}
function planCodex(file, o) {
  const next = JSON.parse(JSON.stringify(file || {}));
  next.hooks = next.hooks || {};
  const post = next.hooks.PostToolUse = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];
  if (hasSpin(post)) return { next, changed: false };
  post.push({ matcher: '*', hooks: [{ type: 'command', command: command(o, 'codex'), timeout: o.codexTimeout }] });
  return { next, changed: true };
}
function validate(file, before, source) {
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const same = JSON.stringify((before.hooks || {}).PreToolUse || null) === JSON.stringify((after.hooks || {}).PreToolUse || null);
  if (!same) throw new Error(`${file}: PreToolUse entries changed unexpectedly`);
  if (!hasSpin((after.hooks || {}).PostToolUse)) throw new Error(`${file}: spin hook entry missing after write`);
  for (const [key, value] of Object.entries(before)) if (key !== 'hooks' && JSON.stringify(after[key]) !== JSON.stringify(value)) throw new Error(`${file}: ${key} changed unexpectedly`);
  return `${source}: ${file} is valid JSON; PreToolUse preserved; PostToolUse runs the spin hook`;
}

function install(o, log = console.log) {
  if (!fs.existsSync(o.hook)) throw new Error(`hook not found: ${o.hook}`);
  const targets = [];
  if (o.only !== 'codex') targets.push({ source: 'claude', file: o.claudeSettings, plan: planClaude });
  if (o.only !== 'claude') targets.push({ source: 'codex', file: o.codexHooks, plan: planCodex });
  const results = [];
  for (const target of targets) {
    const before = readJson(target.file);
    const { next, changed } = target.plan(before, o);
    if (!changed) { log(`${target.source}: already installed in ${target.file}`); results.push({ ...target, changed: false }); continue; }
    const entry = next.hooks.PostToolUse[next.hooks.PostToolUse.length - 1];
    log(`${target.source}: will add to ${target.file} → hooks.PostToolUse:\n${JSON.stringify(entry, null, 2)}`);
    if (!o.yes) { results.push({ ...target, changed: false, planned: entry }); continue; }
    const copy = backup(target.file);
    writeJson(target.file, next);
    log(`${target.source}: backup ${copy || '(no previous file)'}`);
    log(validate(target.file, before, target.source));
    results.push({ ...target, changed: true, backup: copy });
  }
  if (!o.yes) log('\nDry run only. Re-run with --yes to back up and write these files.');
  else if (results.some(r => r.source === 'codex' && r.changed)) log('\nCodex: on its next start it will say a hook is new and needs review ("Hooks can run outside the sandbox after you trust them"). Choose to trust it, or review it under /hooks. Until trusted, Codex does not run it. config.toml was not modified by this script.');
  return results;
}

if (require.main === module) {
  try { install(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`spin-install: ${error.message}`); process.exitCode = 1; }
}
module.exports = { install, parseArgs, planClaude, planCodex, MARKER, command };
