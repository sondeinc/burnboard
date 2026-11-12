'use strict';

// Homebrew installs each version of a formula under
// <prefix>/Cellar/<formula>/<version>/ and deletes that directory when the
// formula is upgraded, while <prefix>/opt/<formula> always links to the
// installed version. `process.execPath` resolves through that link to the
// versioned path, so a hook command written from it stops working at the next
// `brew upgrade`. This returns the opt path instead, when it exists and is the
// same binary; any other path is returned as given.
const fs = require('node:fs');
const path = require('node:path');

const CELLAR = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/(node[^/]*)$/;

function stableNodePath(node) {
  const match = CELLAR.exec(String(node || ''));
  if (!match) return node;
  const [, prefix, formula, binary] = match;
  const opt = path.posix.join(prefix, 'opt', formula, 'bin', binary);
  try { return fs.realpathSync(opt) === fs.realpathSync(node) ? opt : node; } catch (_) { return node; }
}

module.exports = { stableNodePath };
