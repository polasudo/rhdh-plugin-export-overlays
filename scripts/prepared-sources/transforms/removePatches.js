#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  Loop 2 parity, Module B: strip yarn "patch:" resolutions from package.json
  and the matching entries from yarn.lock. Mirrors
  update-workspace.js --remove-patches — internal-fork dependency patches
  (resolutions pointing at .yarn/patches/*.patch) aren't meant to ship in an
  exported/decoupled plugin tree.

  The caller is still responsible for `rm -rf .yarn/patches` itself — this
  module only edits package.json/yarn.lock, matching the original's split of
  responsibility.
*/

'use strict';

const fs = require('node:fs');
const { deleteYarnLockBlocksByPackageNames } = require('./yarnLockBlocks.js');

// A resolutions key is a package name or "name@range" selector. Extract the
// bare package name (handling scoped packages, e.g.
// "@backstage/core-plugin-api@npm:^1.9.0" -> "@backstage/core-plugin-api").
function packageNameFromResolutionKey(key) {
  const match = /^(@[^@]+\/[^@]+|[^@]+)@/.exec(key);
  return match ? match[1] : key;
}

// Pure transform: given a parsed package.json object, remove every
// "resolutions" entry whose value is a string starting with "patch:".
// Returns a new object (does not mutate the input) plus the bare package
// names removed, for feeding into the yarn.lock cleanup step.
function removePatchResolutions(pkg) {
  if (!pkg.resolutions || typeof pkg.resolutions !== 'object') {
    return { pkg, removed: [] };
  }

  const resolutions = { ...pkg.resolutions };
  const removed = [];
  for (const [key, value] of Object.entries(resolutions)) {
    if (typeof value === 'string' && value.startsWith('patch:')) {
      delete resolutions[key];
      removed.push(packageNameFromResolutionKey(key));
    }
  }

  if (removed.length === 0) {
    return { pkg, removed: [] };
  }

  return { pkg: { ...pkg, resolutions }, removed };
}

// Orchestrates the file I/O: read package.json, strip patch resolutions,
// write back only if something changed, then remove matching yarn.lock
// blocks (if a yarn.lock path is given and exists).
function removePatches(packageJsonPath, yarnLockPath) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const { pkg: updatedPkg, removed } = removePatchResolutions(pkg);

  if (removed.length === 0) {
    return { removed: [], yarnLockRemoved: [] };
  }

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(updatedPkg, null, 2)}\n`);

  let yarnLockRemoved = [];
  if (yarnLockPath && fs.existsSync(yarnLockPath)) {
    const content = fs.readFileSync(yarnLockPath, 'utf8');
    const result = deleteYarnLockBlocksByPackageNames(content, removed);
    if (result.removed.length > 0) {
      fs.writeFileSync(yarnLockPath, result.content);
    }
    yarnLockRemoved = result.removed;
  }

  return { removed, yarnLockRemoved };
}

module.exports = {
  packageNameFromResolutionKey,
  removePatchResolutions,
  removePatches,
};
