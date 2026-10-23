'use strict';

// The spin scorer version: a short hash of everything that can change a score.
// That is the scoring code (lib/spin.js), the reference quantiles
// (lib/spin-reference.json) and the scoring part of the config (thresholds,
// the pattern lists, claudeMaxLevel). Display-only settings (notifications,
// nudges, sources, retention, dashboard URL) and UI code are deliberately left
// out, so changing them never triggers a rescore. Comment-only edits, blank
// lines and line endings (CRLF checkouts) do not change the hash either.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UNVERSIONED = 'unversioned'; // scored before versions were recorded
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function normalizeCode(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line && !/^\s*\/\//.test(line))
    .join('\n');
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

let codeCache = null;
function codeHash(dir = __dirname) {
  if (codeCache && codeCache.dir === dir) return codeCache.hash;
  const code = normalizeCode(fs.readFileSync(path.join(dir, 'spin.js'), 'utf8'));
  const reference = stable(JSON.parse(fs.readFileSync(path.join(dir, 'spin-reference.json'), 'utf8')));
  const hash = sha(`spin.js\n${code}\nspin-reference.json\n${reference}`).slice(0, 16);
  codeCache = { dir, hash };
  return hash;
}
function scoringConfig(cfg = {}) {
  const spin = require('./spin');
  const c = spin.mergeConfig(spin.DEFAULT_CONFIG, cfg || {});
  return { thresholds: c.thresholds, ceremonyPatterns: c.ceremonyPatterns, gatePatterns: c.gatePatterns,
    mergePatterns: c.mergePatterns, reviewHelperPatterns: c.reviewHelperPatterns, claudeMaxLevel: c.claudeMaxLevel };
}
function scorerVersion(cfg = {}, { dir } = {}) {
  return `s1-${sha(`${codeHash(dir)}\n${stable(scoringConfig(cfg))}`).slice(0, 12)}`;
}
const versionOf = value => (value && value.scorer) || UNVERSIONED;

module.exports = { scorerVersion, scoringConfig, codeHash, normalizeCode, versionOf, UNVERSIONED,
  _resetCache: () => { codeCache = null; } };
