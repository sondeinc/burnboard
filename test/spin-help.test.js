'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const help = require('../lib/ui/spin-help');
const ui = require('../lib/ui/flight-recorder');
const spin = require('../lib/spin');
const store = require('../lib/spin-store');
const { scorerVersion } = require('../lib/spin-version');
const { render: renderReadme } = require('../scripts/spin-help-readme');
const { createDocument } = require('./fake-dom');

const config = store.validateConfig({}).config;
const get = (object, dotted) => dotted.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
const set = (object, dotted, value) => {
  const keys = dotted.split('.'); let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] = { ...(target[key] || {}) };
  target[keys[keys.length - 1]] = value;
};
function renderForm() {
  const dom = createDocument();
  const host = dom.parse(ui.settingsForm(config, { archive: {}, hookInstalled: {} }));
  const controller = help.attach(host, { doc: dom.doc, win: dom.win, hoverDelayMs: 1 });
  const button = key => host.querySelector(`[data-spin-help="${key}"]`);
  const pop = key => host.querySelector(`[data-spin-help-pop="${key}"]`);
  const visible = () => host.querySelectorAll('.fr-help-pop').filter(node => !node.hidden).map(node => node.getAttribute('data-spin-help-pop'));
  return { ...dom, host, controller, button, pop, visible };
}

test('every threshold setting (and every other explained setting) has an (i) with non-empty text', () => {
  const { host, button, pop } = renderForm();
  const fields = ['thresholds.watch', 'thresholds.alert', 'thresholds.reviewRoundWatch', 'thresholds.reviewRoundAlert', 'thresholds.backToBackRepeat',
    'claudeMaxLevel', 'desktop.minLevel', 'desktop.cooldownMinutes', 'agentNudge.mode', 'agentNudge.minLevel', 'episodes.retentionDays'];
  for (const field of fields) {
    const input = host.querySelector(`[data-spin="${field}"]`);
    assert.ok(input, field);
    const row = input.closest('.fr-help-row');
    assert.ok(row, `${field} sits in a help row`);
    const btn = row.querySelector('[data-spin-help]');
    assert.ok(btn, `${field} has an (i) button`);
    assert.equal(btn.tagName, 'BUTTON'); assert.equal(btn.getAttribute('type'), 'button');
    assert.match(btn.getAttribute('aria-label'), /^About \S/);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.ok(!input.closest('label').contains(btn), 'the button is outside the label');
    const target = host.querySelector(`#${btn.getAttribute('aria-controls')}`);
    assert.equal(target, pop(btn.getAttribute('data-spin-help')));
    assert.equal(target.getAttribute('role'), 'dialog');
    assert.ok(target.hidden, 'closed until opened');
    assert.ok(host.querySelector(`#${target.getAttribute('aria-labelledby')}`).textContent.trim());
    assert.ok(target.textContent.trim().length > 80, `${field} has real text`);
  }
  for (const key of ['scoreCalc', 'patterns', 'activity']) assert.ok(button(key) && pop(key).textContent.trim().length > 80, key);
  const ids = host.querySelectorAll('.fr-help-pop').map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, 'pop-up ids are unique');
  assert.equal(ids.length, Object.keys(help.TOPICS).length, 'every topic is shown');
  assert.equal(button('watch').getAttribute('aria-label'), 'About Watch score threshold');
});

test('the score explanations cover what the scorer does', () => {
  const watch = help.plainText('watch');
  for (const part of ['~120 actions', 'five signals', 'higher than X% of sessions', 'equal weight', 'last three readings', '0 means calm', 'worst sessions on record', 'fewer false alarms', 'catches churn later'])
    assert.ok(watch.includes(part), part);
  const calc = help.TOPICS.scoreCalc;
  assert.equal(calc.list.length, 5, 'one entry per scorer signal');
  assert.deepEqual(calc.list.map(item => item.name), ['Process ceremony share', 'New files touched', 'Highest review round mentioned', 'Waiting per action', 'Near-repeat commands']);
  assert.match(calc.list[0].text, /pattern list in spin\.json/);
  assert.match(calc.list[1].text, /fewer new files is more churn-like/);
  assert.match(calc.list[2].text, /“round N”, “pass N” or “rnd N”/);
  // The windows, span and lookback the text quotes are the scorer's own.
  const reference = require('../lib/spin-reference.json');
  assert.equal(reference.windowActions, 40); assert.equal(reference.spanWindows, 3); assert.equal(reference.sustainReadings, 3);
  // Near-repeat example: same skeleton; back-to-back example: polling is waiting.
  assert.equal(spin.skeleton('gh pr checks 812'), spin.skeleton('gh pr checks 815'));
  assert.match(help.plainText('claudeMaxLevel'), /never notified or nudged/);
  assert.match(help.plainText('backToBackRepeat'), /reports it as waiting/);
});

test('defaults and the nudge message quoted in the pop-ups match the code', () => {
  for (const [key, topic] of Object.entries(help.TOPICS)) {
    for (const [setting, text] of Object.entries(topic.defaults || {})) {
      const actual = get(config, setting);
      if (text === 'blank') assert.equal(actual, null, setting);
      else if (typeof actual === 'number') assert.equal(Number(text), actual, setting);
      else assert.equal(text, actual, setting);
      assert.ok(help.plainText(key).includes(`default ${text === 'blank' ? '' : text}`.trim()) || help.plainText(key).includes('(default)'), `${key} names its default`);
    }
  }
  const message = spin.nudgeText(['x']);
  assert.ok(message.startsWith('Spin check: x. '));
  assert.ok(message.endsWith(help.NUDGE_TAIL));
  assert.ok(help.plainText('nudgeMode').includes(`“Spin check: (the top reasons). ${help.NUDGE_TAIL}”`));
});

test('the rescore note appears on scorer-version settings and not on others', () => {
  const { pop } = renderForm();
  const base = scorerVersion(config);
  for (const [key, topic] of Object.entries(help.TOPICS)) {
    const note = pop(key).querySelector('.fr-help-rescore');
    if (topic.scorer === null) { assert.equal(note, null, key); continue; }
    // Whether the setting really is a scorer-version input, measured.
    const changes = topic.setting.some(setting => {
      const next = JSON.parse(JSON.stringify(config)), value = get(config, setting);
      set(next, setting, Array.isArray(value) ? ['changed'] : value == null ? 30 : typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${value}-changed`);
      return scorerVersion(next) !== base;
    });
    assert.equal(topic.scorer, changes, `${key}: scorer flag matches spin-version`);
    assert.equal(note.getAttribute('data-rescore'), changes ? 'yes' : 'no', key);
    assert.equal(note.textContent, changes ? help.RESCORE_YES : help.RESCORE_NO, key);
    assert.equal(pop(key).textContent.includes('Rescore: yes'), changes, key);
  }
  for (const key of ['watch', 'alert', 'reviewRoundWatch', 'reviewRoundAlert', 'backToBackRepeat', 'claudeMaxLevel', 'patterns']) assert.equal(help.TOPICS[key].scorer, true, key);
  for (const key of ['desktopLevel', 'desktopCooldown', 'nudgeMode', 'nudgeLevel', 'retention', 'activity']) assert.equal(help.TOPICS[key].scorer, false, key);
});

test('keyboard: Enter and Space open and close a pop-up, Escape closes it and returns focus', () => {
  const { dispatch, doc, button, pop, visible } = renderForm();
  const watch = button('watch');
  watch.focus();
  const enter = dispatch(watch, { type: 'keydown', key: 'Enter' });
  assert.ok(enter.defaultPrevented);
  assert.deepEqual(visible(), ['watch']);
  assert.equal(watch.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, pop('watch'), 'focus moves into the pop-up');
  dispatch(watch, { type: 'keyup', key: 'Enter' });
  dispatch(pop('watch'), { type: 'keydown', key: 'Escape' });
  assert.deepEqual(visible(), []);
  assert.equal(watch.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, watch, 'focus returns to the (i)');
  dispatch(watch, { type: 'keydown', key: ' ' });
  assert.deepEqual(visible(), ['watch']);
  // The click a browser synthesizes for that key press is not a second toggle.
  dispatch(watch, { type: 'click', detail: 0 });
  assert.deepEqual(visible(), ['watch']);
  dispatch(watch, { type: 'keydown', key: ' ' });
  assert.deepEqual(visible(), [], 'Space again closes it');
  assert.equal(doc.activeElement, watch);
  const style = pop('watch').style;
  assert.ok(style.left && style.top && style.maxHeight, 'positioned when opened');
});

test('click toggles, a click outside closes, and only one pop-up is open at a time', () => {
  const { dispatch, host, button, pop, visible } = renderForm();
  dispatch(button('watch'), { type: 'click', detail: 1 });
  assert.deepEqual(visible(), ['watch']);
  dispatch(pop('watch').querySelector('p'), { type: 'click', detail: 1 });
  assert.deepEqual(visible(), ['watch'], 'clicking inside keeps it open');
  dispatch(button('alert'), { type: 'click', detail: 1 });
  assert.deepEqual(visible(), ['alert'], 'opening another closes the first');
  assert.equal(button('watch').getAttribute('aria-expanded'), 'false');
  dispatch(button('scoreCalc'), { type: 'keydown', key: 'Enter' });
  assert.deepEqual(visible(), ['scoreCalc']);
  dispatch(host.querySelector('[data-spin="thresholds.watch"]').closest('label'), { type: 'click', detail: 1 });
  assert.deepEqual(visible(), [], 'a click outside closes it');
  dispatch(button('claudeMaxLevel'), { type: 'click', detail: 1 });
  dispatch(button('claudeMaxLevel'), { type: 'click', detail: 1 });
  assert.deepEqual(visible(), [], 'a second click closes it');
});

test('hover previews a pop-up for mouse users without overriding a pinned one', async () => {
  const { dispatch, button, pop, visible, host } = renderForm();
  dispatch(button('retention'), { type: 'pointerover', pointerType: 'mouse' });
  assert.deepEqual(visible(), ['retention']);
  dispatch(button('retention'), { type: 'pointerout', pointerType: 'mouse', relatedTarget: pop('retention') });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(visible(), ['retention'], 'moving onto the pop-up keeps it open');
  dispatch(pop('retention'), { type: 'pointerout', pointerType: 'mouse', relatedTarget: host });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(visible(), [], 'leaving closes a hover preview');
  dispatch(button('watch'), { type: 'pointerover', pointerType: 'touch' });
  assert.deepEqual(visible(), [], 'touch uses tap, not hover');
  dispatch(button('watch'), { type: 'click', detail: 1 });
  dispatch(button('alert'), { type: 'pointerover', pointerType: 'mouse' });
  assert.deepEqual(visible(), ['watch'], 'a pinned pop-up stays');
  dispatch(button('watch'), { type: 'pointerout', pointerType: 'mouse', relatedTarget: host });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(visible(), ['watch']);
});

test('pop-ups are placed inside the viewport', () => {
  const viewport = { width: 800, height: 600 };
  const inside = (spot, size) => spot.left >= 8 && spot.top >= 8 && spot.left + Math.min(size.width, spot.maxWidth) <= viewport.width - 8 && spot.top + Math.min(size.height, spot.maxHeight) <= viewport.height - 8;
  const size = { width: 360, height: 240 };
  for (const rect of [{ left: 10, top: 10, bottom: 26 }, { left: 780, top: 10, bottom: 26 }, { left: 780, top: 570, bottom: 586 }, { left: 300, top: 300, bottom: 316 }]) {
    assert.ok(inside(help.place(rect, size, viewport), size), JSON.stringify(rect));
  }
  assert.equal(help.place({ left: 300, top: 500, bottom: 516 }, size, viewport).top, 500 - 6 - 240, 'flips above near the bottom');
  const tall = help.place({ left: 0, top: 0, bottom: 16 }, { width: 2000, height: 2000 }, viewport);
  assert.deepEqual([tall.left, tall.top, tall.maxWidth, tall.maxHeight], [8, 8, 784, 584]);
});

test('README setting explanations are generated from the same text', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  assert.equal(renderReadme(readme), readme, 'run node scripts/spin-help-readme.js');
  for (const topic of Object.values(help.TOPICS)) assert.ok(readme.includes(`**${topic.title}.**`), topic.title);
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="/spin-help.js"></script>') > 0 && html.indexOf('/spin-help.js') < html.indexOf('/flight-recorder.js'));
  assert.match(fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8'), /'\/spin-help\.js'\]\.includes\(pathn\)/);
});
