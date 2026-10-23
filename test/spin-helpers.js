'use strict';
// Synthetic Codex / Claude transcript lines for the spin watch tests.
const start = Date.parse('2026-03-02T12:00:00Z');
const iso = seconds => new Date(start + seconds * 1000).toISOString();

const codex = {
  meta: (id, cwd = '/home/dev/Repos/app/.worktrees/a/b', extra = {}) => JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { id, cwd, source: 'cli', ...extra } }),
  user: (s, text) => JSON.stringify({ timestamp: iso(s), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } }),
  cmd: (s, command, exit = 0, out = 'ok') => JSON.stringify({ timestamp: iso(s), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', command], exit_code: exit, aggregated_output: out, status: 'completed' } } }),
  edit: (s, file) => JSON.stringify({ timestamp: iso(s), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { [file]: { type: 'update', unified_diff: '+a\n-b' } } } } }),
  say: (s, text) => JSON.stringify({ timestamp: iso(s), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
  wait: s => JSON.stringify({ timestamp: iso(s), type: 'response_item', payload: { type: 'function_call', name: 'wait', arguments: '{}', call_id: `w${s}` } }),
  noise: (s, bytes) => JSON.stringify({ timestamp: iso(s), type: 'event_msg', payload: { type: 'token_count', pad: 'x'.repeat(bytes) } }),
};
const claude = {
  user: (s, text) => JSON.stringify({ type: 'user', timestamp: iso(s), cwd: '/home/dev/Repos/app', message: { role: 'user', content: text } }),
  bash: (s, id, command) => JSON.stringify({ type: 'assistant', timestamp: iso(s), cwd: '/home/dev/Repos/app', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }),
  result: (s, id, text = 'ok', isError = false) => JSON.stringify({ type: 'user', timestamp: iso(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, toolUseResult: {} }),
  say: (s, text) => JSON.stringify({ type: 'assistant', timestamp: iso(s), message: { id: `t${s}`, content: [{ type: 'text', text }] } }),
};

// Healthy building: new files, varied commands.
function healthyCodex(id, n = 160) {
  const lines = [codex.meta(id)];
  for (let i = 0; i < n; i++) lines.push(i % 2 ? codex.edit(10 + i * 20, `src/feature-${i}.js`) : codex.cmd(10 + i * 20, `node build-step-${String.fromCharCode(97 + (i % 26))}${i}.js --target ${'abcdefghij'[i % 10]}`));
  return lines;
}
// Merge-gate treadmill: gate runs, lint-fix, re-merge main, CI polls, waits, no new files.
function treadmillCodex(id, n = 240) {
  const lines = [codex.meta(id)];
  const cmds = ['pnpm run pre-merge --regenerate', 'pnpm lint --fix --base origin/main', 'git fetch origin && git merge origin/main', 'gh pr checks 1234'];
  for (let i = 0; i < n; i++) { lines.push(codex.cmd(10 + i * 30, `${cmds[i % cmds.length]} # ${i % 7}`)); lines.push(codex.wait(11 + i * 30)); }
  return lines;
}

module.exports = { start, iso, codex, claude, healthyCodex, treadmillCodex };
