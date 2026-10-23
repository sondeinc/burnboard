#!/usr/bin/env node
'use strict';
// Rewrites the "Setting explanations" block in README.md from lib/ui/spin-help.js,
// the same text the (i) pop-ups in the Attention Brief show.
// `--check` only reports whether the README is up to date (exit 1 if not).
const fs = require('node:fs');
const path = require('node:path');
const help = require('../lib/ui/spin-help');

const file = path.resolve(__dirname, '..', 'README.md');
function render(readme) {
  const start = readme.indexOf(help.README_START), end = readme.indexOf(help.README_END);
  if (start < 0 || end < start) throw new Error('README.md has no spin-help block markers');
  return readme.slice(0, start) + help.markdown() + readme.slice(end + help.README_END.length);
}
if (require.main === module) {
  const readme = fs.readFileSync(file, 'utf8');
  const next = render(readme);
  if (process.argv.includes('--check')) {
    if (next !== readme) { console.error('README.md spin setting explanations are out of date: run node scripts/spin-help-readme.js'); process.exit(1); }
    console.log('README.md spin setting explanations are up to date');
  } else if (next !== readme) { fs.writeFileSync(file, next); console.log('Updated README.md'); } else console.log('README.md already up to date');
}
module.exports = { render };
