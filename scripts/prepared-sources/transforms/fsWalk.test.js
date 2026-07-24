#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { findPackageJsonFiles, findYarnLock } = require('./fsWalk.js');

function mkTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fswalk-test.'));
}

function write(root, relPath, content = '{}') {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

test('findPackageJsonFiles finds every package.json under a tree (excluding ignored dirs)', () => {
  const root = mkTree();
  write(root, 'package.json');
  write(root, 'packages/app/package.json');
  write(root, 'plugins/foo/package.json');
  write(root, 'plugins/foo/dist-dynamic/package.json'); // dist-dynamic is ignored, see next test

  const found = findPackageJsonFiles(root).sort();
  assert.equal(found.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findPackageJsonFiles skips node_modules, .git, dist, dist-dynamic, build, coverage', () => {
  const root = mkTree();
  write(root, 'package.json');
  write(root, 'node_modules/dep/package.json');
  write(root, '.git/hooks/package.json');
  write(root, 'dist/package.json');
  write(root, 'dist-dynamic/package.json');
  write(root, 'build/package.json');
  write(root, 'coverage/package.json');

  const found = findPackageJsonFiles(root);
  assert.deepEqual(found, [path.join(root, 'package.json')]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findYarnLock finds the nearest yarn.lock walking up from a package.json', () => {
  const root = mkTree();
  const workspaceRoot = path.join(root, 'workspaces', 'topology');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'yarn.lock'), '');
  const nested = write(root, 'workspaces/topology/plugins/topology/package.json');

  assert.equal(findYarnLock(nested), path.join(workspaceRoot, 'yarn.lock'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('findYarnLock returns null when it walks up to a directory named "workspaces" with no yarn.lock', () => {
  const root = mkTree();
  const nested = write(root, 'workspaces/topology/plugins/topology/package.json');

  assert.equal(findYarnLock(nested), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findYarnLock prefers the closest yarn.lock over a more distant one', () => {
  const root = mkTree();
  fs.mkdirSync(path.join(root, 'workspaces', 'topology'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'topology', 'yarn.lock'), 'outer');
  fs.mkdirSync(path.join(root, 'workspaces', 'topology', 'plugins', 'topology'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'topology', 'plugins', 'topology', 'yarn.lock'), 'inner');
  const nested = write(root, 'workspaces/topology/plugins/topology/package.json');

  assert.equal(
    findYarnLock(nested),
    path.join(root, 'workspaces', 'topology', 'plugins', 'topology', 'yarn.lock'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});
