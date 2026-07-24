#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  Loop 2 parity, Module C: strip dangling dependency references to packages
  that were (or will be) physically removed from the tree — e.g. the
  Backstage monorepo's dev-only host packages ("app", "app-next", "backend").
  Mirrors update-workspace.js --delete.

  Important: this is reference cleanup only, NOT folder deletion. Confirmed
  against the original — it edits package.json/yarn.lock dependency-map
  entries; removing the actual package directories is a separate concern
  (this repo's own "unneeded package" scrub step, not this module).
*/

'use strict';

const fs = require('node:fs');
const { deleteYarnLockBlocksByPackageNames } = require('./yarnLockBlocks.js');
const { packageNameFromResolutionKey } = require('./removePatches.js');

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'resolutions',
];

// Pure transform: remove exact-name matches for packageNames from every
// dependency-map section of a parsed package.json. Section keys other than
// "resolutions" are always bare package names; "resolutions" keys may carry
// a "@range" selector suffix, so the bare name is extracted first (same
// convention as Module B's patch-resolution cleanup).
function deleteDependencyReferences(pkg, packageNames) {
  const nameSet = new Set(packageNames);
  const deleted = [];
  const updated = { ...pkg };
  let changed = false;

  for (const section of DEPENDENCY_SECTIONS) {
    const original = pkg[section];
    if (!original || typeof original !== 'object') {
      continue;
    }
    const sectionCopy = { ...original };
    let sectionChanged = false;
    for (const key of Object.keys(sectionCopy)) {
      const bareName = section === 'resolutions' ? packageNameFromResolutionKey(key) : key;
      if (nameSet.has(bareName)) {
        delete sectionCopy[key];
        deleted.push({ section, key });
        sectionChanged = true;
      }
    }
    if (sectionChanged) {
      updated[section] = sectionCopy;
      changed = true;
    }
  }

  return { pkg: changed ? updated : pkg, deleted };
}

// Orchestrates the file I/O for one package.json + its nearest yarn.lock.
// Unlike Module B, yarn.lock cleanup is attempted whenever a yarn.lock path
// is given and exists, even if this particular package.json had nothing to
// delete — dangling yarn.lock entries can outlive the package.json that
// used to reference them (e.g. after a previous, unrelated edit).
function pruneUnneededPackages(packageJsonPath, yarnLockPath, packageNames) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const { pkg: updatedPkg, deleted } = deleteDependencyReferences(pkg, packageNames);

  if (deleted.length > 0) {
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(updatedPkg, null, 2)}\n`);
  }

  let yarnLockRemoved = [];
  if (yarnLockPath && fs.existsSync(yarnLockPath)) {
    const content = fs.readFileSync(yarnLockPath, 'utf8');
    const result = deleteYarnLockBlocksByPackageNames(content, packageNames);
    if (result.removed.length > 0) {
      fs.writeFileSync(yarnLockPath, result.content);
    }
    yarnLockRemoved = result.removed;
  }

  return { deleted, yarnLockRemoved };
}

module.exports = {
  DEPENDENCY_SECTIONS,
  deleteDependencyReferences,
  pruneUnneededPackages,
};
