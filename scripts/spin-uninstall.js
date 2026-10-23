#!/usr/bin/env node
'use strict';

// Removes only the spin watch PostToolUse entries added by spin-install.js.
//
//   node scripts/spin-uninstall.js          # show what would be removed
//   node scripts/spin-uninstall.js --yes    # back up, remove, and validate
//
// Accepts the same --claude-settings / --codex-hooks / --only overrides as the
// installer. Every other hook (including `rtk hook` PreToolUse) is untouched,
// and Codex's config.toml is never modified; a leftover trusted_hash entry for
// the removed hook is harmless.
const fs = require('node:fs');
const { parseArgs, MARKER } = require('./spin-install');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function strip(value) {
  const next = JSON.parse(JSON.stringify(value || {}));
  const post = next.hooks && next.hooks.PostToolUse;
  if (!Array.isArray(post)) return { next, removed: 0 };
  let removed = 0;
  const groups = [];
  for (const group of post) {
    const hooks = (group.hooks || []).filter(hook => { const spin = String(hook.command || '').includes(MARKER); if (spin) removed++; return !spin; });
    if (hooks.length) groups.push({ ...group, hooks });
  }
  if (groups.length) next.hooks.PostToolUse = groups; else delete next.hooks.PostToolUse;
  return { next, removed };
}

function uninstall(o, log = console.log) {
  const targets = [];
  if (o.only !== 'codex') targets.push({ source: 'claude', file: o.claudeSettings });
  if (o.only !== 'claude') targets.push({ source: 'codex', file: o.codexHooks });
  const results = [];
  for (const target of targets) {
    if (!fs.existsSync(target.file)) { log(`${target.source}: ${target.file} does not exist`); continue; }
    const before = JSON.parse(fs.readFileSync(target.file, 'utf8'));
    const { next, removed } = strip(before);
    if (!removed) { log(`${target.source}: no spin hook in ${target.file}`); results.push({ ...target, removed: 0 }); continue; }
    log(`${target.source}: will remove ${removed} spin hook entr${removed === 1 ? 'y' : 'ies'} from ${target.file}`);
    if (!o.yes) { results.push({ ...target, removed: 0, planned: removed }); continue; }
    const copy = `${target.file}.bak-spin-${stamp()}`;
    fs.copyFileSync(target.file, copy);
    const tmp = `${target.file}.spin-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, target.file);
    const after = JSON.parse(fs.readFileSync(target.file, 'utf8'));
    if (JSON.stringify((after.hooks || {}).PreToolUse || null) !== JSON.stringify((before.hooks || {}).PreToolUse || null)) throw new Error(`${target.file}: PreToolUse changed unexpectedly`);
    log(`${target.source}: removed; backup ${copy}; file is valid JSON`);
    results.push({ ...target, removed, backup: copy });
  }
  if (!o.yes) log('\nDry run only. Re-run with --yes to back up and write these files.');
  return results;
}

if (require.main === module) {
  try { uninstall(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`spin-uninstall: ${error.message}`); process.exitCode = 1; }
}
module.exports = { uninstall, strip };
