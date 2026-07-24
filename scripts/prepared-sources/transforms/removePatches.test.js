#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  packageNameFromResolutionKey,
  removePatchResolutions,
  removePatches,
} = require('./removePatches.js');

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remove-patches-test.'));
}

test('packageNameFromResolutionKey extracts scoped and unscoped package names', () => {
  assert.equal(
    packageNameFromResolutionKey('@backstage/core-plugin-api@npm:^1.9.0'),
    '@backstage/core-plugin-api',
  );
  assert.equal(packageNameFromResolutionKey('lodash@^4.17.21'), 'lodash');
  assert.equal(packageNameFromResolutionKey('lodash'), 'lodash');
});

test('removePatchResolutions strips only patch: resolutions, leaves normal ones', () => {
  const pkg = {
    name: 'x',
    resolutions: {
      '@backstage/core-plugin-api@npm:^1.9.0':
        'patch:@backstage/core-plugin-api@npm%3A1.9.3#./.yarn/patches/x.patch',
      '@backstage/theme@npm:^0.5.0':
        'patch:@backstage/theme@npm%3A0.5.0#./.yarn/patches/y.patch',
      lodash: '^4.17.21',
    },
  };

  const { pkg: updated, removed } = removePatchResolutions(pkg);

  assert.deepEqual(removed.sort(), ['@backstage/core-plugin-api', '@backstage/theme']);
  assert.deepEqual(updated.resolutions, { lodash: '^4.17.21' });
  // Original object is not mutated.
  assert.equal(Object.keys(pkg.resolutions).length, 3);
});

test('removePatchResolutions is a no-op when there are no patch resolutions', () => {
  const pkg = { name: 'x', resolutions: { lodash: '^4.17.21' } };
  const { pkg: updated, removed } = removePatchResolutions(pkg);
  assert.deepEqual(removed, []);
  assert.equal(updated, pkg);
});

test('removePatchResolutions is a no-op when there is no resolutions field at all', () => {
  const pkg = { name: 'x' };
  const { pkg: updated, removed } = removePatchResolutions(pkg);
  assert.deepEqual(removed, []);
  assert.equal(updated, pkg);
});

test('removePatches strips patch resolutions from package.json and matching yarn.lock blocks', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: 'x',
      resolutions: {
        '@backstage/core-plugin-api@npm:^1.9.0':
          'patch:@backstage/core-plugin-api@npm%3A1.9.3#./.yarn/patches/x.patch',
        lodash: '^4.17.21',
      },
    }),
  );
  fs.writeFileSync(
    yarnLockPath,
    [
      '__metadata:',
      '  version: 8',
      '',
      '"@backstage/core-plugin-api@patch:@backstage/core-plugin-api@npm%3A1.9.3#./.yarn/patches/x.patch::version=1.9.3&hash=abcd":',
      '  version: 1.9.3',
      '  languageName: node',
      '  linkType: hard',
      '',
      '"lodash@npm:^4.17.21":',
      '  version: 4.17.21',
      '  languageName: node',
      '  linkType: hard',
      '',
    ].join('\n'),
  );

  const { removed, yarnLockRemoved } = removePatches(packageJsonPath, yarnLockPath);

  assert.deepEqual(removed, ['@backstage/core-plugin-api']);
  assert.equal(yarnLockRemoved.length, 1);

  const updatedPkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.deepEqual(updatedPkg.resolutions, { lodash: '^4.17.21' });

  const updatedLock = fs.readFileSync(yarnLockPath, 'utf8');
  assert.doesNotMatch(updatedLock, /core-plugin-api/);
  assert.match(updatedLock, /lodash/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('removePatches does not touch package.json or yarn.lock when there is nothing to remove', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');
  const pkgContent = JSON.stringify({ name: 'x', resolutions: { lodash: '^4.17.21' } });
  const lockContent = '"lodash@npm:^4.17.21":\n  version: 4.17.21\n';
  fs.writeFileSync(packageJsonPath, pkgContent);
  fs.writeFileSync(yarnLockPath, lockContent);

  const { removed, yarnLockRemoved } = removePatches(packageJsonPath, yarnLockPath);

  assert.deepEqual(removed, []);
  assert.deepEqual(yarnLockRemoved, []);
  assert.equal(fs.readFileSync(packageJsonPath, 'utf8'), pkgContent);
  assert.equal(fs.readFileSync(yarnLockPath, 'utf8'), lockContent);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('removePatches is idempotent across two runs', () => {
  const dir = mkDir();
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnLockPath = path.join(dir, 'yarn.lock');
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: 'x',
      resolutions: { pkg: 'patch:pkg@npm%3A1.0.0#./.yarn/patches/p.patch' },
    }),
  );
  fs.writeFileSync(
    yarnLockPath,
    '"pkg@patch:pkg@npm%3A1.0.0#./.yarn/patches/p.patch::hash=abcd":\n  version: 1.0.0\n',
  );

  removePatches(packageJsonPath, yarnLockPath);
  const afterFirst = {
    pkg: fs.readFileSync(packageJsonPath, 'utf8'),
    lock: fs.readFileSync(yarnLockPath, 'utf8'),
  };
  const second = removePatches(packageJsonPath, yarnLockPath);

  assert.deepEqual(second.removed, []);
  assert.equal(fs.readFileSync(packageJsonPath, 'utf8'), afterFirst.pkg);
  assert.equal(fs.readFileSync(yarnLockPath, 'utf8'), afterFirst.lock);

  fs.rmSync(dir, { recursive: true, force: true });
});
