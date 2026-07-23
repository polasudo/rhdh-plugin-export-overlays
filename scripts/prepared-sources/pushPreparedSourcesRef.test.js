#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseArgs,
  readSourceRef,
  sanitizeTagComponent,
  main,
  DEFAULT_REGISTRY,
} = require('./pushPreparedSourcesRef.js');

test('sanitizeTagComponent strips characters invalid in OCI tags', () => {
  assert.equal(sanitizeTagComponent('feat/RHIDP-15700-prepared-sources-ref'), 'feat-RHIDP-15700-prepared-sources-ref');
  assert.equal(sanitizeTagComponent('release-1.10'), 'release-1.10');
  assert.equal(sanitizeTagComponent('main'), 'main');
  assert.equal(sanitizeTagComponent('.leading-dot'), 'leading-dot');
  assert.equal(sanitizeTagComponent(''), 'unknown');
});

test('parseArgs reads required flags', () => {
  const opts = parseArgs([
    '--dir',
    '/tmp/tree',
    '--workspace',
    'workspaces/topology',
    '--overlay-branch',
    'main',
    '--overlay-commit',
    'abc',
    '--source-ref',
    'deadbeef',
    '--dry-run',
  ]);
  assert.equal(opts.workspace, 'topology');
  assert.equal(opts.overlayBranch, 'main');
  assert.equal(opts.sourceRef, 'deadbeef');
  assert.equal(opts.dryRun, true);
  assert.equal(opts.registry, DEFAULT_REGISTRY);
});

test('readSourceRef extracts repo-ref', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-overlay.'));
  const file = path.join(dir, 'source.json');
  fs.writeFileSync(file, JSON.stringify({ 'repo-ref': 'v1.42.5' }));
  assert.equal(readSourceRef(file), 'v1.42.5');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('main dry-run packs without pushing and logs both mutable and pinned tags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-main.'));
  const tree = path.join(root, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'README.md'), 'ok\n');
  const sourceJson = path.join(root, 'source.json');
  fs.writeFileSync(sourceJson, JSON.stringify({ 'repo-ref': 'abc123' }));

  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(msg);

  let code;
  try {
    code = main([
      '--dir',
      tree,
      '--workspace',
      'topology',
      '--overlay-branch',
      'main',
      '--overlay-commit',
      '0123456789abcdef0123456789abcdef01234567',
      '--source-json',
      sourceJson,
      '--dry-run',
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(code, 0);
  const output = lines.join('\n');
  assert.match(output, new RegExp(`${DEFAULT_REGISTRY}:topology-main[^-]`.replace(/[.]/g, '\\.')));
  assert.match(output, new RegExp(`${DEFAULT_REGISTRY}:topology-main-0123456`.replace(/[.]/g, '\\.')));
  fs.rmSync(root, { recursive: true, force: true });
});
