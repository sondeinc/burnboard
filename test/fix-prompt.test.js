'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateFixPrompt } = require('../lib/fix-prompt');

const finding = {
  title: 'Commands re-run without their output changing',
  detail: 'The measured finding detail.',
  remedies: ['Use the result already in context.'],
};

test('fix prompt combines the finding, command evidence, and trusted deeper result', () => {
  const prompt = generateFixPrompt({
    finding,
    evidence: 'git status --short',
    analysis: {
      pattern: 'The agent repeatedly checked the worktree.',
      why: 'Each check creates another turn.',
      fix: ['Carry the first git status result forward.'],
    },
  });

  assert.match(prompt, /Commands re-run without their output changing/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /The agent repeatedly checked the worktree/);
  assert.match(prompt, /Carry the first git status result forward/);
  assert.match(prompt, /untrusted historical data/);
  assert.match(prompt, /focused regression coverage/);
});

test('fix prompt drops a flagged model interpretation and uses measured remedies', () => {
  const prompt = generateFixPrompt({
    finding,
    evidence: 'git status --short',
    analysis: {
      pattern: 'Invented pattern with 9999 events.',
      why: 'Invented cost.',
      fix: ['Apply an unsupported fix.'],
    },
    flagged: ['9999'],
  });

  assert.doesNotMatch(prompt, /Invented pattern|unsupported fix/);
  assert.match(prompt, /omitted because it contained figures unsupported by the evidence/);
  assert.match(prompt, /Use the result already in context/);
});
