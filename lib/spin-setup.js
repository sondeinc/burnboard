'use strict';

// Spin watch setup check: is the hook installed, pointing at this checkout,
// approved in Codex, running, and are the settings able to do what they say?
// Shared by `node server.js` (printed on start, --spin-check-only) and
// GET /api/spin/setup. The check and API are read-only. Interactive startup
// can install a selected hook only after the user explicitly chooses it; this
// module never writes Codex's config.toml or the spin config.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./spin-store');

const MARKER = 'spin-hook.js';
const LEVELS = ['calm', 'watch', 'alert'];
const rank = level => Math.max(0, LEVELS.indexOf(level));
const DAY = 86400000;
const MARK = { ok: '✓', warn: '!', missing: '✗' };
const SETTINGS_PLACE = 'Attention Brief → Rule controls → Spin watch settings';
const COMMANDS = {
  install: 'node scripts/spin-install.js --yes',
  reinstall: 'node scripts/spin-uninstall.js --yes && node scripts/spin-install.js --yes',
  backfill: 'node scripts/spin-backfill.js',
};

function setupPaths(overrides = {}) {
  const p = store.paths(overrides);
  const env = process.env;
  const codexHooks = overrides.codexHooks || env.BURNBOARD_CODEX_HOOKS || path.join(p.codexHome, 'hooks.json');
  const claudeSettings = overrides.claudeSettings || env.BURNBOARD_CLAUDE_SETTINGS || path.join(p.claudeHome, 'settings.json');
  return { ...p, claudeSettings, codexHooks,
    codexConfig: overrides.codexConfig || env.BURNBOARD_CODEX_CONFIG || path.join(path.dirname(codexHooks), 'config.toml'),
    checkoutDir: overrides.checkoutDir || path.resolve(__dirname, '..') };
}

const exists = file => { try { return !!file && fs.existsSync(file); } catch (_) { return false; } };
const real = file => { try { return fs.realpathSync(file); } catch (_) { return path.resolve(file); } };
const tilde = file => { const home = os.homedir(); return file && home && (file === home || file.startsWith(home + path.sep)) ? '~' + file.slice(home.length) : file; };
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } }
function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// Splits a hook command the way a POSIX shell would for the simple forms the
// installer writes (bare words, "double quoted", 'single quoted').
function splitCommand(command) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(command || '')))) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2] != null ? m[2] : m[3]);
  return out;
}

// Finds the spin entry in a Claude Code settings.json or Codex hooks.json.
function findHook(file) {
  const text = readText(file);
  if (text == null) return { file, fileExists: false, installed: false };
  let json;
  try { json = text.trim() ? JSON.parse(text) : {}; } catch (error) { return { file, fileExists: true, installed: false, invalid: error.message }; }
  const groups = json && json.hooks && Array.isArray(json.hooks.PostToolUse) ? json.hooks.PostToolUse : [];
  const found = [];
  groups.forEach((group, i) => (group && Array.isArray(group.hooks) ? group.hooks : []).forEach((hook, j) => {
    if (hook && String(hook.command || '').includes(MARKER)) found.push({ groupIndex: i, handlerIndex: j, group, hook });
  }));
  if (!found.length) return { file, fileExists: true, installed: false };
  const { groupIndex, handlerIndex, group, hook } = found[0];
  const words = splitCommand(hook.command);
  const hookPath = words.find(word => word.endsWith(MARKER)) || null;
  const node = words[0] && words[0] !== hookPath ? words[0] : null;
  return { file, fileExists: true, installed: true, count: found.length, groupIndex, handlerIndex, group, entry: hook,
    command: hook.command, hookPath, node };
}

function hookItem(id, label, tool, homeDir, info, checkoutDir) {
  const expected = real(path.join(checkoutDir, 'bin', MARKER));
  const out = { id, label, tool, file: info.file, installed: info.installed, hookPath: info.hookPath || null, node: info.node || null };
  if (!info.installed && !exists(homeDir) && !info.fileExists) return { ...out, status: 'ok', skipped: true, text: `${tool} not found on this computer; nothing to set up` };
  if (info.invalid) return { ...out, status: 'missing', repair: false, text: `${tilde(info.file)} is not valid JSON (${info.invalid}); fix it before installing` };
  if (!info.installed) return { ...out, status: 'missing', repair: 'install', text: `not installed in ${tilde(info.file)}` };
  const problems = [];
  out.hookExists = !!info.hookPath && exists(info.hookPath);
  out.thisCheckout = !!info.hookPath && real(info.hookPath) === expected;
  out.nodeExists = info.node ? exists(info.node) : null;
  if (!info.hookPath) problems.push('its command has no spin-hook.js path');
  else if (!out.hookExists) problems.push(`it points to ${tilde(info.hookPath)}, which no longer exists`);
  else if (!out.thisCheckout) problems.push(`it points to another checkout (${tilde(path.dirname(path.dirname(info.hookPath)))})`);
  if (info.node && !out.nodeExists) problems.push(`its Node binary ${tilde(info.node)} no longer exists`);
  if (problems.length) return { ...out, status: 'missing', repair: 'reinstall', text: `installed, but ${problems.join(' and ')}` };
  return { ...out, status: 'ok', text: `installed; runs this checkout's hook${info.node ? ' with a Node that exists' : ''}${info.count > 1 ? ` (${info.count} spin entries; one is enough)` : ''}` };
}

// --- Codex approval --------------------------------------------------------
// Codex keeps approvals in config.toml as
//   [hooks.state."<hooks.json path>:post_tool_use:<group>:<handler>"]
//   trusted_hash = "sha256:<hex>"
// This is a minimal reader for exactly those tables (and the inline-table form
// under [hooks.state]); it is not a general TOML parser.
function tomlString(raw) {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return raw.slice(1, -1).replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\(.)/g, (_, u4, u8, c) =>
    u4 || u8 ? String.fromCodePoint(parseInt(u4 || u8, 16)) : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[c] || c));
}
const STR = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`;
function readHookStates(text) {
  const states = new Map();
  let current = null, inState = false;
  const field = (body, name) => { const m = body.match(new RegExp(String.raw`(?:^|[\s,{])${name}\s*=\s*(${STR}|true|false)`)); return m ? m[1] : null; };
  const assign = (key, body) => {
    const state = states.get(key) || {};
    const hash = field(body, 'trusted_hash'), enabled = field(body, 'enabled');
    if (hash) state.trustedHash = tomlString(hash);
    if (enabled) state.enabled = enabled === 'true';
    states.set(key, state);
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const header = line.match(new RegExp(String.raw`^\[\s*hooks\s*\.\s*state\s*\.\s*(${STR})\s*\]`));
    if (header) { current = tomlString(header[1]); inState = false; states.set(current, states.get(current) || {}); continue; }
    if (/^\[\s*hooks\s*\.\s*state\s*\]/.test(line)) { current = null; inState = true; continue; }
    if (line.startsWith('[')) { current = null; inState = false; continue; }
    if (current) { assign(current, line); continue; }
    const inline = inState && line.match(new RegExp(String.raw`^(${STR})\s*=\s*\{(.*)\}`));
    if (inline) assign(tomlString(inline[1]), inline[2]);
  }
  return states;
}

// Reproduces Codex's hook trust hash (codex-rs hooks discovery, checked
// against Codex 0.164): the hook is normalized to
//   { event_name, matcher, hooks: [{ type, command, timeout, async, statusMessage?, additionalContextLimit? }] }
// (timeout defaults to 600 s, absent values are dropped, commandWindows is
// left out, additionalContextLimit is kept only when it is not the 2,500
// default), every object's keys are sorted, and the compact JSON is hashed
// with SHA-256. Because Codex could change this scheme, a mismatch is only
// reported as "changed" when the same scheme reproduces at least one other
// approved hook in the same hooks.json; otherwise it says "can't confirm".
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const NO_MATCHER_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'PreModelRequest', 'PostModelRequest']);
const eventLabel = event => event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
function codexHookHash(event, group, hook) {
  if (!hook || (hook.type && hook.type !== 'command') || typeof hook.command !== 'string') return null;
  const timeout = Number.isInteger(hook.timeout) && hook.timeout >= 0 ? Math.max(1, hook.timeout) : 600;
  const handler = { type: 'command', command: hook.command, timeout, async: hook.async === true };
  if (typeof hook.statusMessage === 'string') handler.statusMessage = hook.statusMessage;
  if (Number.isInteger(hook.additionalContextLimit) && hook.additionalContextLimit !== 2500) handler.additionalContextLimit = hook.additionalContextLimit;
  const identity = { event_name: eventLabel(event), hooks: [handler] };
  if (typeof (group && group.matcher) === 'string' && !NO_MATCHER_EVENTS.has(event)) identity.matcher = group.matcher;
  return `sha256:${crypto.createHash('sha256').update(stableJson(identity)).digest('hex')}`;
}
function hookKey(hooksFile, event, i, j) { return `${hooksFile}:${eventLabel(event)}:${i}:${j}`; }

function codexApproval(p, codexHook, codexItem) {
  const base = { id: 'codex-approval', label: 'Codex approval' };
  if (codexItem.skipped) return { ...base, status: 'ok', skipped: true, text: 'Codex not found on this computer; nothing to approve' };
  if (!codexHook.installed) return { ...base, status: 'missing', state: 'no-hook', text: 'nothing to approve until the Codex hook is installed' };
  const states = readHookStates(readText(p.codexConfig));
  const keys = [...new Set([codexHook.file, real(codexHook.file)])];
  const lookup = (event, i, j) => { for (const file of keys) { const s = states.get(hookKey(file, event, i, j)); if (s) return s; } return null; };
  const state = lookup('PostToolUse', codexHook.groupIndex, codexHook.handlerIndex);
  const current = codexHookHash('PostToolUse', codexHook.group, codexHook.entry);
  // Calibrate the hash scheme on every other approved hook in hooks.json.
  let calibrated = false, json = {};
  try { json = JSON.parse(readText(codexHook.file) || '{}'); } catch (_) {}
  for (const [event, groups] of Object.entries((json && json.hooks) || {})) {
    (Array.isArray(groups) ? groups : []).forEach((group, i) => ((group && group.hooks) || []).forEach((hook, j) => {
      const other = lookup(event, i, j);
      if (other && other.trustedHash && other.trustedHash === codexHookHash(event, group, hook)) calibrated = true;
    }));
  }
  const out = { ...base, key: hookKey(codexHook.file, 'PostToolUse', codexHook.groupIndex, codexHook.handlerIndex), currentHash: current,
    trustedHash: state && state.trustedHash || null, hashVerified: calibrated };
  if (state && state.enabled === false) return { ...out, status: 'missing', state: 'disabled', text: 'the spin hook is turned off in Codex (/hooks); turn it back on there' };
  if (!state || !state.trustedHash) return { ...out, status: 'missing', state: 'not-approved', text: 'not approved yet; Codex skips the hook until you trust it' };
  if (state.trustedHash === current) return { ...out, status: 'ok', state: 'approved', hashVerified: true, text: 'approved, and the approval matches the current hook entry' };
  if (calibrated) return { ...out, status: 'missing', state: 'changed', text: 'approved earlier, but the hook entry changed since; Codex will ask again' };
  return { ...out, status: 'warn', state: 'found', text: "approval found; can't confirm it matches the current hook entry" };
}

// --- activity, settings, archive ------------------------------------------------
function activity(p, now, anyHook) {
  const latest = { claude: 0, codex: 0 };
  let names = [];
  try { names = fs.readdirSync(p.sessionsDir); } catch (_) {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const source = name.startsWith('claude-') ? 'claude' : name.startsWith('codex-') ? 'codex' : null;
    if (!source) continue;
    try { const t = fs.statSync(path.join(p.sessionsDir, name)).mtimeMs; if (t > latest[source]) latest[source] = t; } catch (_) {}
  }
  const lastRun = Math.max(latest.claude, latest.codex) || null;
  const errors = [];
  for (const file of [p.errorsFile + '.1', p.errorsFile]) {
    for (const line of (readText(file) || '').split('\n')) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
      if (m) errors.push({ at: Date.parse(m[1]), message: m[2].replace(/^hook\s+/, '').slice(0, 160) });
    }
  }
  const recent = errors.filter(e => now - e.at < DAY);
  const lastError = errors.length ? errors[errors.length - 1] : null;
  const errorsSinceRun = lastError && (!lastRun || lastError.at > lastRun);
  const out = { id: 'activity', label: 'Hook activity', lastRun, lastRunBySource: { claude: latest.claude || null, codex: latest.codex || null },
    errorsLastDay: recent.length, lastError, errorsFile: p.errorsFile };
  const per = ['claude', 'codex'].filter(s => latest[s]).map(s => `${s === 'claude' ? 'Claude Code' : 'Codex'} ${ago(latest[s], now)}`).join(', ');
  const ran = lastRun ? `last ran ${ago(lastRun, now)}${per.includes(',') ? ` (${per})` : ''}` : 'has not run yet; it runs after an agent\'s next tool call';
  if (recent.length && errorsSinceRun) return { ...out, status: 'warn', text: `${ran}; ${recent.length} error${recent.length === 1 ? '' : 's'} in the last day, latest ${ago(lastError.at, now)}: ${lastError.message} (see ${tilde(p.errorsFile)})` };
  const earlier = recent.length ? `no errors since (${recent.length} earlier in the last day)` : 'no recent errors';
  if (!lastRun) return { ...out, status: anyHook ? 'warn' : 'ok', text: ran };
  return { ...out, status: 'ok', text: `${ran}; ${earlier}` };
}

function settings(config) {
  const c = config, notes = [], claudeOn = c.sources.claude, codexOn = c.sources.codex;
  const desktop = c.desktop.enabled ? `on (${c.desktop.minLevel === 'alert' ? 'alert only' : 'watch or alert'})` : 'off';
  const nudge = c.agentNudge.mode === 'off' ? 'off' : `${c.agentNudge.mode} (${c.agentNudge.minLevel === 'alert' ? 'alert only' : 'watch or alert'})`;
  const out = { id: 'settings', label: 'Settings', enabled: c.enabled, desktop: { enabled: c.desktop.enabled, minLevel: c.desktop.minLevel },
    nudge: { mode: c.agentNudge.mode, minLevel: c.agentNudge.minLevel }, claudeMaxLevel: c.claudeMaxLevel, sources: c.sources,
    impossible: [], notes };
  if (!c.enabled) notes.push(`Spin watch is switched off ("Spin watch sensor enabled" in ${SETTINGS_PLACE}), so nothing is scored.`);
  if (!claudeOn) notes.push('Claude Code is switched off under Sources, so its threads are not watched.');
  if (!codexOn) notes.push('Codex is switched off under Sources, so its threads are not watched.');
  // Claude threads are capped at claudeMaxLevel, so anything that starts at a
  // higher level can never happen for Claude.
  if (c.enabled && claudeOn) {
    const cap = c.claudeMaxLevel;
    if (c.agentNudge.mode !== 'off' && rank(cap) < rank(c.agentNudge.minLevel)) out.impossible.push('nudge');
    if (c.desktop.enabled && rank(cap) < rank(c.desktop.minLevel)) out.impossible.push('desktop');
    if (out.impossible.length) {
      const what = out.impossible.map(k => k === 'nudge' ? 'nudged' : 'notified').join(' or ');
      const levels = [...new Set(out.impossible.map(k => k === 'nudge' ? c.agentNudge.minLevel : c.desktop.minLevel))];
      const starts = `${out.impossible.map(k => k === 'nudge' ? 'nudges' : 'notifications').join(' and ')} start at ${levels.join('/')}`;
      const fix = rank(cap) >= rank('watch') ? 'set "Claude Code at most" to alert, or "At" to "watch or alert"' : 'set "Claude Code at most" to watch or alert';
      notes.push(`Claude Code threads can never be ${what}: Claude is capped at ${cap} (claudeMaxLevel) but ${starts}. To change it, ${fix} in ${SETTINGS_PLACE}.`);
    }
  }
  if (c.enabled && c.agentNudge.mode === 'shadow') notes.push(`Nudges are only logged (shadow mode); agents aren't told. Switch them on in ${SETTINGS_PLACE} → Agent nudge → Mode.`);
  const warn = !c.enabled || !claudeOn || !codexOn || out.impossible.length > 0;
  return { ...out, status: warn ? 'warn' : 'ok', text: `desktop notifications ${desktop}; agent nudges ${nudge}` };
}

function archive(p, now) {
  const progress = store.readJson(p.progressFile, null);
  const ran = !!progress || exists(p.manifestFile);
  const out = { id: 'archive', label: 'Archive', backfillRan: ran, lastBackfill: progress && (progress.finishedAt || progress.updatedAt) || null,
    pendingThreads: 0, current: null, running: false, episodes: 0, threads: 0 };
  try {
    const brief = require('./spin-brief').createSpinBrief({ paths: p });
    const v = brief.versions({ now });
    Object.assign(out, { pendingThreads: v.pendingThreads, current: v.current, running: !!(v.rescore && v.rescore.running) });
    const size = store.archiveSize(p);
    out.episodes = size.episodes; out.threads = size.files;
  } catch (error) { out.error = error.message; }
  const count = `${out.episodes.toLocaleString('en-US')} episode${out.episodes === 1 ? '' : 's'} in ${out.threads.toLocaleString('en-US')} session${out.threads === 1 ? '' : 's'}`;
  if (out.running) return { ...out, status: 'ok', text: `${count}; a backfill/rescore is running now` };
  if (!ran) return { ...out, status: 'warn', text: `${count}; backfill has never run, so past sessions are not scored yet` };
  const when = out.lastBackfill ? `backfill last ran ${ago(out.lastBackfill, now)}` : 'backfill has run';
  if (out.pendingThreads) return { ...out, status: 'warn', text: `${count}; ${when}; ${out.pendingThreads.toLocaleString('en-US')} session${out.pendingThreads === 1 ? ' needs' : 's need'} a rescore (the scorer changed)` };
  return { ...out, status: 'ok', text: `${count}; ${when}; scores are current` };
}

// --- the whole check ----------------------------------------------------------------
function check(overrides = {}) {
  const p = setupPaths(overrides);
  const now = overrides.now || Date.now();
  let config;
  try { config = store.loadConfig(p, { create: false }); } catch (_) { config = store.validateConfig({}).config; }
  const claudeHook = findHook(p.claudeSettings), codexHook = findHook(p.codexHooks);
  const claude = hookItem('claude-hook', 'Claude Code hook', 'Claude Code', path.dirname(p.claudeSettings), claudeHook, p.checkoutDir);
  const codex = hookItem('codex-hook', 'Codex hook', 'Codex', path.dirname(p.codexHooks), codexHook, p.checkoutDir);
  const approval = codexApproval(p, codexHook, codex);
  const items = [claude, codex, approval, activity(p, now, claudeHook.installed || codexHook.installed), settings(config), archive(p, now)];
  const steps = nextSteps(items);
  const missing = items.some(item => item.status === 'missing');
  const ready = items.every(item => item.status === 'ok');
  const repair = [claude, codex].filter(item => item.repair).map(item => ({ tool: item.id === 'claude-hook' ? 'claude' : 'codex', action: item.repair }));
  const status = { checkout: p.checkoutDir, checkedAt: now, ready, missing, nudgeMode: config.agentNudge.mode, items, nextSteps: steps, repair,
    files: { claudeSettings: p.claudeSettings, codexHooks: p.codexHooks, codexConfig: p.codexConfig, spinConfig: p.configFile, stateDir: p.stateDir } };
  status.text = format(status).join('\n');
  return status;
}

// Only what is missing, in the README's order. A stale hook is reinstalled in
// the install slot, because approving and restarting only make sense after it.
function nextSteps(items) {
  const by = Object.fromEntries(items.map(item => [item.id, item]));
  const steps = [];
  const hooks = [by['claude-hook'], by['codex-hook']];
  const toInstall = hooks.filter(item => item.repair === 'install').map(item => item.tool);
  const toReinstall = hooks.filter(item => item.repair === 'reinstall').map(item => item.tool);
  if (toInstall.length) steps.push({ id: 'install', command: COMMANDS.install,
    text: `Install the hook for ${toInstall.join(' and ')}: run \`${COMMANDS.install}\` in this checkout.` });
  if (toReinstall.length) steps.push({ id: 'reinstall', command: COMMANDS.reinstall,
    text: `Reinstall the hook for ${toReinstall.join(' and ')} (the checkout moved or Node changed): run \`${COMMANDS.reinstall}\` in this checkout.` });
  const codexChanging = [...toInstall, ...toReinstall].includes('Codex');
  const approval = by['codex-approval'];
  const needsApproval = !approval.skipped && (codexChanging || ['not-approved', 'changed', 'no-hook'].includes(approval.state));
  if (needsApproval) steps.push({ id: 'approve', command: 'codex',
    text: 'Approve the hook in Codex: run `codex` in a terminal, open `/hooks`, review and trust/enable the spin hook, then type `/quit`. Do this in a terminal so you can inspect the hook before trusting it.' });
  if (approval.state === 'disabled') steps.push({ id: 'enable', text: 'Turn the spin hook back on in Codex: run `codex`, open /hooks, and enable it.' });
  const claudeChanging = [...toInstall, ...toReinstall].includes('Claude Code');
  const restart = [];
  if (needsApproval || codexChanging || approval.state === 'disabled') restart.push('Restart every Codex process, or the editor host that runs it, so it loads the hook.');
  if (claudeChanging) restart.push('Restart every Claude Code session or host so it reloads `settings.json`.');
  if (restart.length) steps.push({ id: 'restart', text: restart.join(' ') });
  const arch = by.archive;
  if (!arch.running && (!arch.backfillRan || arch.pendingThreads)) steps.push({ id: 'backfill', command: COMMANDS.backfill,
    text: `${arch.backfillRan ? 'Rescore older sessions' : 'Score your history (optional)'}: run \`${COMMANDS.backfill}\`.` });
  if (by.settings.enabled && by.settings.nudge.mode === 'shadow') steps.push({ id: 'nudge',
    text: `If you want agents nudged, switch nudge mode from shadow to "nudge the agent" in ${SETTINGS_PLACE}.` });
  return steps;
}

function format(status) {
  const settingsItem = status.items.find(item => item.id === 'settings');
  if (status.ready) {
    const mode = settingsItem.nudge.mode;
    const hint = mode === 'shadow' ? ` (nudges are only logged; switch them on in ${SETTINGS_PLACE})` : mode === 'off' ? ' (agents are never nudged)' : ' (agents are told when they spin)';
    return [`Spin watch: ready · nudge mode: ${mode}${hint}`];
  }
  const lines = ['Spin watch'];
  for (const item of status.items) {
    lines.push(`  ${MARK[item.status]} ${item.label}: ${item.text}`);
    for (const note of item.notes || []) lines.push(`      ${note}`);
  }
  if (status.nextSteps.length) {
    lines.push('Next steps');
    status.nextSteps.forEach((step, i) => lines.push(`  ${i + 1}. ${step.text}`));
  }
  return lines;
}

// Installs or repairs the hooks this check found missing or stale, with the
// real config paths. Only ever called after the user said yes at a terminal.
function repair(status, log = console.log, selectedTools = null) {
  const { install, parseArgs } = require('../scripts/spin-install');
  const { uninstall } = require('../scripts/spin-uninstall');
  const selected = selectedTools && new Set(selectedTools);
  const touched = [];
  for (const { tool, action } of status.repair) {
    if (selected && !selected.has(tool)) continue;
    const o = { ...parseArgs([]), only: tool, yes: true, claudeSettings: status.files.claudeSettings, codexHooks: status.files.codexHooks,
      hook: path.join(status.checkout, 'bin', MARKER) };
    try {
      if (action === 'reinstall') uninstall(o, log);
      install(o, () => {});
      log(`  ${tool === 'claude' ? 'Claude Code' : 'Codex'}: hook ${action === 'reinstall' ? 'repaired' : 'installed'} in ${tilde(tool === 'claude' ? o.claudeSettings : o.codexHooks)} (a backup was saved next to it)`);
      touched.push(tool);
    } catch (error) { log(`  ${tool === 'claude' ? 'Claude Code' : 'Codex'}: could not install the hook: ${error.message}`); }
  }
  if (touched.includes('codex')) {
    log('  Codex next: run `codex` in a terminal, open `/hooks`, review and trust/enable the spin hook, then type `/quit`.');
    log('  Restart every Codex process, or the editor host that runs it, so it loads the hook.');
  }
  if (touched.includes('claude')) log('  Claude Code next: restart every Claude Code session or host so it reloads `~/.claude/settings.json`.');
  return touched;
}

function repairPrompt(repairs) {
  if (repairs.length === 1) {
    const label = repairs[0].tool === 'codex' ? 'Codex' : 'Claude Code';
    return `Install or repair the Spin watch hook for ${label} now? [y/N] `;
  }
  return 'Install or repair Spin watch hooks now? [1] Codex [2] Claude Code [3] both [Enter] skip: ';
}

function selectedRepairs(repairs, answer) {
  const value = String(answer || '').trim().toLowerCase();
  if (repairs.length === 1) return value === 'y' || value === 'yes' ? [repairs[0].tool] : [];
  if (value === '1' || value === 'codex' || value === 'c') return ['codex'];
  if (value === '2' || value === 'claude' || value === 'claude code') return ['claude'];
  if (value === '3' || value === 'both' || value === 'all' || value === 'y' || value === 'yes') return repairs.map(item => item.tool);
  return [];
}

// Startup: print the block, and at a terminal offer once to install/repair.
// Never waits on anything but the optional prompt; the server is already up.
function startup({ input = process.stdin, output = process.stdout, log = console.log, overrides = {}, interactive } = {}) {
  let status;
  try { status = check(overrides); } catch (error) { log(`Spin watch: couldn't check the setup (${error.message})`); return Promise.resolve(null); }
  for (const line of status.text.split('\n')) log(line);
  const tty = interactive != null ? interactive : !!(input && input.isTTY && output && output.isTTY);
  if (!tty || !status.repair.length) return Promise.resolve({ status, asked: false });
  return new Promise(resolve => {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input, output });
    let done = false;
    const finish = answer => {
      if (done) return; done = true; rl.close();
      const selected = selectedRepairs(status.repair, answer);
      if (selected.length) { const touched = repair(status, log, selected); resolve({ status, asked: true, installed: touched }); }
      else { log('  Left unchanged. The next steps above still apply.'); resolve({ status, asked: true, installed: [] }); }
    };
    // Ctrl+C at the prompt stops the server, as it would without the prompt.
    rl.on('SIGINT', () => { rl.close(); process.kill(process.pid, 'SIGINT'); });
    rl.on('close', () => finish(''));
    rl.question(repairPrompt(status.repair), finish);
  });
}

module.exports = { check, format, nextSteps, startup, repair, repairPrompt, selectedRepairs, setupPaths, splitCommand, findHook, readHookStates, codexHookHash, hookKey, MARK };
