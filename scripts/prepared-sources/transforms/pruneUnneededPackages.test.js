#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { deleteDependencyReferences, pruneUnneededPackages } = require('./pruneUnneededPackages.js');

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test.'));
}

test('deleteDependencyReferences removes exact-name matches across all five sections', () => {
  const pkg = {
    name: '@internal/plugin',
    dependencies: { app: '0.0.0', lodash: '^4.17.21' },
    devDependencies: { 'app-next': '0.0.0', eslint: '^8.0.0' },
    peerDependencies: { backend: '0.0.0' },
    optionalDependencies: { app: '0.0.0' },
    resolutions: { 'app@npm:*': '0.0.0', lodash: '^4.17.21' },
  };

  const { pkg: updated, deleted } = deleteDependencyReferences(pkg, ['app', 'app-next', 'backend']);

  assert.deepEqual(updated.dependencies, { lodash: '^4.17.21' });
  assert.deepEqual(updated.devDependencies, { eslint: '^8.0.0' });
  assert.deepEqual(updated.peerDependencies, {});
  assert.deepEqual(updated.optionalDependencies, {});
  assert.deepEqual(updated.resolutions, { lodash: '^4.17.21' });
  assert.equal(deleted.length, 5);
});

test('deleteDependencyReferences matches resolutions keys by bare name even with a range selector', () => {
  const pkg = { resolutions: { 'app@npm:^1.0.0': '0.0.0' } };
  const { pkg: updated, deleted } = deleteDependencyReferences(pkg, ['app']);
  assert.deepEqual(updated.resolutions, {});
  assert.equal(deleted.length, 1);
});

test('deleteDependencyReferences does not match partial/prefix names', () => {
  const pkg = { dependencies: { 'app-extra': '1.0.0' } };
  const { pkg: updated, deleted } = deleteDependencyReferences(pkg, ['app']);
  assert.deepEqual(updated.dependencies, { 'app-extra': '1.0.0' });
  assert.deepEqual(deleted, []);
});

test('deleteDependencyReferences is a no-op (returns the same object) when nothing matches', () => {
  const pkg = { dependencies: { lodash: '^4.17.21' } };
  const { pkg: updated, deleted } = deleteDependencyReferences(pkg, ['app']);
  assert.equal(updated, pkg);
  assert.deepEqual(deleted, []);
});

test('deleteDependencyReferences ignores sections that are absent', () => {
  const pkg = { name: 'x' };
  const { pkg: updated, deleted } = deleteDependencyReferences(pkg, ['app']);
  assert.equal(updated, pkg);
  assert.deepEqual(deleted, []);
});

test('pruneUnneededPackages prunes package.json and yarn.lock together', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: '@internal/plugin',
      dependencies: { app: '0.0.0', lodash: '^4.17.21' },
    }),
  );
  fs.writeFileSync(
    yarnLockPath,
    [
      '"@internal/app@workspace:packages/app":',
      '  version: 0.0.0-use.local',
      '  languageName: unknown',
      '  linkType: soft',
      '',
      '"lodash@npm:^4.17.21":',
      '  version: 4.17.21',
      '  languageName: node',
      '  linkType: hard',
      '',
    ].join('\n'),
  );

  const { deleted, yarnLockRemoved } = pruneUnneededPackages(packageJsonPath, yarnLockPath, [
    'app',
    '@internal/app',
  ]);

  assert.equal(deleted.length, 1);
  assert.equal(yarnLockRemoved.length, 1);

  const updatedPkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.deepEqual(updatedPkg.dependencies, { lodash: '^4.17.21' });

  const updatedLock = fs.readFileSync(yarnLockPath, 'utf8');
  assert.doesNotMatch(updatedLock, /@internal\/app/);
  assert.match(updatedLock, /lodash/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneUnneededPackages still cleans yarn.lock even when package.json had nothing to delete', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');
  const pkgContent = JSON.stringify({ name: 'x', dependencies: { lodash: '^4.17.21' } });
  fs.writeFileSync(packageJsonPath, pkgContent);
  fs.writeFileSync(
    yarnLockPath,
    '"app@workspace:packages/app":\n  version: 0.0.0-use.local\n\n"lodash@npm:^4.17.21":\n  version: 4.17.21\n',
  );

  const { deleted, yarnLockRemoved } = pruneUnneededPackages(packageJsonPath, yarnLockPath, ['app']);

  assert.deepEqual(deleted, []);
  // package.json is untouched since nothing changed there.
  assert.equal(fs.readFileSync(packageJsonPath, 'utf8'), pkgContent);
  // but yarn.lock is still cleaned.
  assert.equal(yarnLockRemoved.length, 1);
  assert.doesNotMatch(fs.readFileSync(yarnLockPath, 'utf8'), /"app@workspace/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneUnneededPackages is idempotent across two runs', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ dependencies: { app: '0.0.0', lodash: '^4.17.21' } }));
  fs.writeFileSync(yarnLockPath, '"app@workspace:packages/app":\n  version: 0.0.0-use.local\n');

  pruneUnneededPackages(packageJsonPath, yarnLockPath, ['app']);
  const afterFirst = {
    pkg: fs.readFileSync(packageJsonPath, 'utf8'),
    lock: fs.readFileSync(yarnLockPath, 'utf8'),
  };
  const second = pruneUnneededPackages(packageJsonPath, yarnLockPath, ['app']);

  assert.deepEqual(second.deleted, []);
  assert.deepEqual(second.yarnLockRemoved, []);
  assert.equal(fs.readFileSync(packageJsonPath, 'utf8'), afterFirst.pkg);
  assert.equal(fs.readFileSync(yarnLockPath, 'utf8'), afterFirst.lock);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneUnneededPackages supports the @internal/ANY wildcard for bulk internal-package cleanup', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ dependencies: {} }));
  fs.writeFileSync(
    yarnLockPath,
    [
      '"@internal/app@workspace:packages/app":',
      '  version: 0.0.0-use.local',
      '',
      '"@internal/backend@workspace:packages/backend":',
      '  version: 0.0.0-use.local',
      '',
      '"lodash@npm:^4.17.21":',
      '  version: 4.17.21',
      '',
    ].join('\n'),
  );

  const { yarnLockRemoved } = pruneUnneededPackages(packageJsonPath, yarnLockPath, ['@internal/ANY']);

  assert.equal(yarnLockRemoved.length, 2);
  const updatedLock = fs.readFileSync(yarnLockPath, 'utf8');
  assert.doesNotMatch(updatedLock, /@internal\//);
  assert.match(updatedLock, /lodash/);

  fs.rmSync(dir, { recursive: true, force: true });
});
