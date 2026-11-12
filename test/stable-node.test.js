'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stableNodePath } = require('../lib/stable-node');

// A Homebrew prefix in a temp dir: Cellar/<formula>/<version>/bin/node, and
// opt/<formula> linked to one version, as `brew` lays it out.
function prefix(t, { formula = 'node@24', versions = ['24.22.3'], linked = versions[versions.length - 1] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-stable-node-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const version of versions) {
    fs.mkdirSync(path.join(dir, 'Cellar', formula, version, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cellar', formula, version, 'bin', 'node'), version);
  }
  if (linked) {
    fs.mkdirSync(path.join(dir, 'opt'), { recursive: true });
    fs.symlinkSync(path.join('..', 'Cellar', formula, linked), path.join(dir, 'opt', formula));
  }
  const cellar = version => path.join(dir, 'Cellar', formula, version, 'bin', 'node');
  return { dir, cellar, opt: path.join(dir, 'opt', formula, 'bin', 'node') };
}

test('a versioned Homebrew node becomes the opt path that survives upgrades', { skip: process.platform === 'win32' }, t => {
  const p = prefix(t);
  assert.equal(stableNodePath(p.cellar('24.22.3')), p.opt);
});

test('the opt path is used only when it is the same binary', { skip: process.platform === 'win32' }, t => {
  const p = prefix(t, { versions: ['24.22.2_2', '24.22.3'], linked: '24.22.3' });
  assert.equal(stableNodePath(p.cellar('24.22.2_2')), p.cellar('24.22.2_2'), 'opt links to another version');
  const unlinked = prefix(t, { linked: null });
  assert.equal(stableNodePath(unlinked.cellar('24.22.3')), unlinked.cellar('24.22.3'), 'no opt link');
});

test('a node outside a Homebrew Cellar is kept as given', () => {
  for (const node of ['/usr/bin/node', '/usr/local/bin/node', '/home/me/.nvm/versions/node/v24.1.0/bin/node',
    'C:\\Program Files\\nodejs\\node.exe', '/opt/homebrew/opt/node@24/bin/node']) {
    assert.equal(stableNodePath(node), node);
  }
});
