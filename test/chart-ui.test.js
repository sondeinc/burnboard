'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function inlineScripts() {
  const found = [];
  let cursor = 0, scripts = 0;
  while (true) {
    const open = html.indexOf('<script>', cursor);
    if (open < 0) break;
    const start = open + '<script>'.length;
    const end = html.indexOf('</script>', start);
    assert.ok(end > start, 'inline dashboard script closes');
    found.push(html.slice(start, end));
    scripts++;
    cursor = end + '</script>'.length;
  }
  assert.equal(scripts, 2);
  return found;
}

test('dashboard chart script parses', () => {
  for (const script of inlineScripts()) assert.doesNotThrow(() => new Function(script));
});

test('saved theme is applied before first paint', () => {
  const document = { documentElement: { dataset: {} } };
  const localStorage = { getItem: key => key === 'burnboard.theme' ? 'everforest-light' : null };
  new Function('localStorage', 'document', inlineScripts()[0])(localStorage, document);
  assert.equal(document.documentElement.dataset.theme, 'everforest-light');
});

test('removed Tokyo Night preference migrates to Burnboard', () => {
  let saved = 'tokyo-night';
  const document = { documentElement: { dataset: {} } };
  const localStorage = {
    getItem: () => saved,
    setItem: (_, value) => { saved = value; },
  };
  new Function('localStorage', 'document', inlineScripts()[0])(localStorage, document);
  assert.equal(saved, 'burnboard');
  assert.equal(document.documentElement.dataset.theme, 'burnboard');
});

test('Activity exposes a fixed-time pace lens with an 8-hour default', () => {
  assert.ok(html.includes('id="runChartMode"'));
  assert.ok(html.includes('data-mode="pace" class="on"'));
  assert.ok(html.includes('<option value="8" selected>8h</option>'));
  assert.ok(html.includes("let runChartMode = 'pace';"));
  assert.ok(html.includes('function paceChart('));
  assert.ok(html.includes('const end = activityChartNow, start = end - hours * 3600000;'));
});

test('History overlays a smoothed trend on the token scale', () => {
  assert.ok(html.includes("lineLabel: 'smoothed trend'"));
  assert.ok(html.includes('lineSharedScale: true, lineSmooth: true'));
  assert.ok(html.includes('function smoothValues('));
  assert.ok(html.includes('function smoothSvgPath('));
});

test('theme picker offers curated dark and light palettes and persists the choice', () => {
  assert.ok(html.includes('id="themeSelect"'));
  assert.ok(html.includes('<span class="theme-label">Theme</span>'));
  for (const theme of ['burnboard', 'catppuccin-mocha', 'rose-pine', 'rose-pine-dawn',
    'everforest-light', 'vitesse-light', 'synthwave-84']) {
    assert.ok(html.includes(`value="${theme}"`), `offers ${theme}`);
  }
  assert.equal((html.match(/tokyo-night/g) || []).length, 1, 'Tokyo Night remains only in migration code');
  assert.ok(html.includes("const THEME_KEY = 'burnboard.theme';"));
  assert.ok(html.includes('localStorage.setItem(THEME_KEY, theme)'));
  assert.ok(html.includes(':root[data-theme="rose-pine-dawn"]'));
  assert.ok(html.includes('color-scheme: light;'));
});

test('plan credits use localized whole numbers rather than currency', () => {
  assert.ok(html.includes('${fmt(rl.credits.balance)} credits'));
  assert.ok(!html.includes('$${esc(rl.credits.balance)} credit'));
});

test('Activity shows rate limits once in the detailed usage summary', () => {
  const script = inlineScripts()[1];
  const renderStart = script.indexOf('function render(snap)');
  const renderEnd = script.indexOf('function agentLimits(', renderStart);
  const render = script.slice(renderStart, renderEnd);
  assert.ok(render.includes("$('#hdrstat').textContent"));
  assert.ok(!render.includes('agentLimits(snap)'), 'header does not duplicate the usage limits');
  assert.ok(html.includes('<div id="usageSummary" class="tgrand" hidden></div>'));
  assert.ok(script.includes('for (const l of agentLimits(snap))'));
});

test('live Activity marks every rebuilt scrolling pane with a stable session key', () => {
  for (const suffix of [':prompt:first', ':prompt:latest', ':commands', ':turns']) {
    assert.ok(html.includes(`t.id + '${suffix}'`), `keys ${suffix}`);
  }
  assert.equal((html.match(/data-scroll-flow="append"/g) || []).length, 2);
  assert.equal((html.match(/data-scroll-flow="prepend"/g) || []).length, 2);
  assert.ok(html.includes("captureScrollState($('#running'), $('#live'))"));
  assert.ok(html.includes("restoreScrollState(scrollState, $('#running'), $('#live'))"));
});

test('live Activity scroll restoration follows append and prepend content', () => {
  const script = inlineScripts()[1];
  const start = script.indexOf('function captureScrollState(');
  const end = script.indexOf('function renderLiveTree(', start);
  assert.ok(start >= 0 && end > start, 'scroll helpers are present');
  const helpers = new Function(`${script.slice(start, end)}; return { captureScrollState, restoreScrollState };`)();
  const root = el => ({ querySelectorAll: () => [el] });
  const pane = (key, flow, top, height = 1000) => ({
    dataset: { scrollKey: key, scrollFlow: flow },
    scrollTop: top, scrollLeft: 7,
    scrollHeight: height, clientHeight: 200,
    scrollWidth: 500, clientWidth: 300,
  });

  const readingAppend = pane('message', 'append', 260);
  const appendState = helpers.captureScrollState(root(readingAppend));
  const longerAppend = pane('message', 'append', 0, 1120);
  helpers.restoreScrollState(appendState, root(longerAppend));
  assert.equal(longerAppend.scrollTop, 260, 'append content keeps an intentional reading offset');
  assert.equal(longerAppend.scrollLeft, 7, 'horizontal position is retained too');

  const bottomAppend = pane('message', 'append', 800);
  const bottomState = helpers.captureScrollState(root(bottomAppend));
  const grownAppend = pane('message', 'append', 0, 1120);
  helpers.restoreScrollState(bottomState, root(grownAppend));
  assert.equal(grownAppend.scrollTop, 920, 'append content remains bottom-pinned');

  const readingLatestFirst = pane('commands', 'prepend', 260);
  const prependState = helpers.captureScrollState(root(readingLatestFirst));
  const longerLatestFirst = pane('commands', 'prepend', 0, 1120);
  helpers.restoreScrollState(prependState, root(longerLatestFirst));
  assert.equal(longerLatestFirst.scrollTop, 380, 'prepended rows do not displace the visible old rows');

  const topLatestFirst = pane('commands', 'prepend', 0);
  const topState = helpers.captureScrollState(root(topLatestFirst));
  const grownLatestFirst = pane('commands', 'prepend', 300, 1120);
  helpers.restoreScrollState(topState, root(grownLatestFirst));
  assert.equal(grownLatestFirst.scrollTop, 0, 'latest-first panes remain pinned to newest rows at the top');
});

test('Activity identifies the session worktree beside repository and branch', () => {
  const script = inlineScripts()[1];
  const start = script.indexOf('function worktreeLabel(');
  const end = script.indexOf('function focusBlock(', start);
  assert.ok(start >= 0 && end > start, 'worktree label helper is present');
  const worktreeLabel = new Function(`${script.slice(start, end)}; return worktreeLabel;`)();

  assert.equal(worktreeLabel('/home/kenpo/Repos/sonde/.worktrees/codex/memory-allocator'),
    'codex/memory-allocator');
  assert.equal(worktreeLabel('/home/kenpo/Repos/sonde/.codex/worktrees/issue-1234'), 'issue-1234');
  assert.equal(worktreeLabel('/home/kenpo/Repos/sonde/'), 'sonde');
  assert.equal(worktreeLabel(null), '');
  assert.ok(html.includes('worktree: ${esc(short(worktree, 56))}'));
  assert.ok(html.includes('title="${attr(t.cwd)}"'));
});

test('Activity has an Active threads header styled like the Attention brief', () => {
  const tab = html.slice(html.indexOf('<section id="tab-running">'), html.indexOf('<section id="tab-history"'));
  const header = tab.match(/<div class="fr-heading run-heading"><div><span class="fr-eyebrow">[^<]+<\/span><h2>Active threads<\/h2><p id="runCount">/);
  assert.ok(header, 'Active threads header uses the Attention brief heading pattern');
  assert.ok(tab.indexOf('Active threads') < tab.indexOf('<div id="running">'), 'header sits above the running list');
  assert.match(html, /\$\('#runCount'\)\.textContent = liveCount/);
  assert.match(html, /thread\$\{liveCount === 1 \? '' : 's'\} running now\./);
});

test('Release Two entry points and Live Monitor remain local and opt-in', () => {
  assert.ok(html.includes('id="attention"'));
  assert.ok(html.includes('data-tab="worktrees"'));
  assert.ok(html.includes('id="worktrees"'));
  assert.ok(html.includes('<script src="/flight-recorder.js"></script>'));
  assert.ok(html.includes("BurnboardFlightRecorder.mount($('#attention'), $('#worktrees'))"));
  const investigation = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'ui', 'investigate.js'), 'utf8');
  assert.match(investigation, /monitor: false/);
  assert.match(investigation, /Turn on Live Monitor/);
  assert.doesNotMatch(investigation, /Agentic monitor/i);
  const flight = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'ui', 'flight-recorder.js'), 'utf8');
  for (const control of ['Acknowledge', 'Snooze 1h', 'Dismiss', 'Rule controls']) assert.ok(flight.includes(control));
  assert.match(investigation, /Human outcome/);
});
