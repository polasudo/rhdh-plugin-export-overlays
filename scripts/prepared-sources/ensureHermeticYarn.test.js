#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readYarnPath,
  setYarnPath,
  hasWorkingYarnPath,
  copyYarnFromRepoRoot,
  removePackageManager,
  ensureHermeticYarn,
} = require('./ensureHermeticYarn.js');

function mkWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-yarn.'));
}

test('readYarnPath returns empty when .yarnrc.yml is missing', () => {
  const dir = mkWorkspace();
  assert.equal(readYarnPath(path.join(dir, '.yarnrc.yml')), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readYarnPath extracts an existing yarnPath', () => {
  const dir = mkWorkspace();
  const yarnrc = path.join(dir, '.yarnrc.yml');
  fs.writeFileSync(yarnrc, 'nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.1.0.cjs\n');
  assert.equal(readYarnPath(yarnrc), '.yarn/releases/yarn-4.1.0.cjs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setYarnPath creates .yarnrc.yml when absent', () => {
  const dir = mkWorkspace();
  const yarnrc = path.join(dir, '.yarnrc.yml');
  setYarnPath(yarnrc, '.yarn/releases/yarn-4.2.0.cjs');
  assert.equal(readYarnPath(yarnrc), '.yarn/releases/yarn-4.2.0.cjs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setYarnPath overwrites an existing yarnPath line in place', () => {
  const dir = mkWorkspace();
  const yarnrc = path.join(dir, '.yarnrc.yml');
  fs.writeFileSync(yarnrc, 'nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-old.cjs\nenableGlobalCache: false\n');
  setYarnPath(yarnrc, '.yarn/releases/yarn-new.cjs');
  const content = fs.readFileSync(yarnrc, 'utf8');
  assert.match(content, /yarnPath: \.yarn\/releases\/yarn-new\.cjs/);
  assert.match(content, /nodeLinker: node-modules/);
  assert.match(content, /enableGlobalCache: false/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hasWorkingYarnPath is false when yarnrc is missing, and false when binary is missing', () => {
  const dir = mkWorkspace();
  assert.equal(hasWorkingYarnPath(dir), false);
  fs.writeFileSync(path.join(dir, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.1.0.cjs\n');
  assert.equal(hasWorkingYarnPath(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hasWorkingYarnPath is true when the pinned binary exists', () => {
  const dir = mkWorkspace();
  fs.mkdirSync(path.join(dir, '.yarn', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.yarn', 'releases', 'yarn-4.1.0.cjs'), '// pinned\n');
  fs.writeFileSync(path.join(dir, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.1.0.cjs\n');
  assert.equal(hasWorkingYarnPath(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removePackageManager strips the field and reports it changed', () => {
  const dir = mkWorkspace();
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ name: 'x', packageManager: 'yarn@4.1.0' }));
  const changed = removePackageManager(pkgPath);
  assert.equal(changed, true);
  assert.equal(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).packageManager, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removePackageManager is a no-op when field is absent', () => {
  const dir = mkWorkspace();
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ name: 'x' }));
  const changed = removePackageManager(pkgPath);
  assert.equal(changed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyYarnFromRepoRoot copies the root-pinned binary and sets yarnPath in the workspace', () => {
  const repoRoot = mkWorkspace();
  const dir = mkWorkspace();
  fs.mkdirSync(path.join(repoRoot, '.yarn', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.yarn', 'releases', 'yarn-4.12.0.cjs'), '// root pinned binary\n');
  fs.writeFileSync(path.join(repoRoot, '.yarnrc.yml'), 'nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.12.0.cjs\n');

  const copied = copyYarnFromRepoRoot(dir, repoRoot);

  assert.equal(copied, true);
  assert.equal(hasWorkingYarnPath(dir), true);
  assert.equal(
    fs.readFileSync(path.join(dir, '.yarn', 'releases', 'yarn-4.12.0.cjs'), 'utf8'),
    '// root pinned binary\n',
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyYarnFromRepoRoot returns false when the root has no usable binary', () => {
  const repoRoot = mkWorkspace();
  const dir = mkWorkspace();
  assert.equal(copyYarnFromRepoRoot(dir, repoRoot), false);
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureHermeticYarn is a no-op download when a valid yarnPath binary already exists', async () => {
  const dir = mkWorkspace();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'yarn@4.1.0' }));
  fs.mkdirSync(path.join(dir, '.yarn', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.yarn', 'releases', 'yarn-4.1.0.cjs'), '// pinned binary\n');
  fs.writeFileSync(path.join(dir, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.1.0.cjs\n');

  await ensureHermeticYarn(dir);

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager, undefined);
  assert.equal(readYarnPath(path.join(dir, '.yarnrc.yml')), '.yarn/releases/yarn-4.1.0.cjs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureHermeticYarn prefers copying from repo root over downloading', async () => {
  const repoRoot = mkWorkspace();
  const dir = mkWorkspace();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@internal/global-header' }));
  fs.mkdirSync(path.join(repoRoot, '.yarn', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.yarn', 'releases', 'yarn-4.12.0.cjs'), '// root pinned binary\n');
  fs.writeFileSync(path.join(repoRoot, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.12.0.cjs\n');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.12.0' }));

  await ensureHermeticYarn(dir, repoRoot);

  assert.equal(hasWorkingYarnPath(dir), true);
  assert.equal(
    fs.readFileSync(path.join(dir, '.yarn', 'releases', 'yarn-4.12.0.cjs'), 'utf8'),
    '// root pinned binary\n',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager, undefined);
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureHermeticYarn throws when packageManager is missing and no yarnPath exists anywhere', async () => {
  const dir = mkWorkspace();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  await assert.rejects(() => ensureHermeticYarn(dir), /No yarnPath.*no yarn packageManager/);
  fs.rmSync(dir, { recursive: true, force: true });
});
