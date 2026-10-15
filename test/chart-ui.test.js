'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('dashboard chart script parses', () => {
  const start = html.lastIndexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  assert.ok(start >= '<script>'.length && end > start, 'inline dashboard script exists');
  assert.doesNotThrow(() => new Function(html.slice(start, end)));
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
