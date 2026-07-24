#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  Loop 2 parity, Module A: shared file-walking helpers, mirroring
  update-workspace.js's findPackageJsonFiles / findYarnLock behavior.
*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'dist-dynamic', 'build', 'coverage']);

// Recursively find every package.json under rootDir, skipping directories
// that never contain a package.json worth transforming.
function findPackageJsonFiles(rootDir) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'package.json') {
        results.push(path.join(dir, 'package.json'));
      }
    }
  }

  walk(rootDir);
  return results;
}

// Walk up from a package.json's directory to find the nearest yarn.lock,
// stopping once a directory literally named "workspaces" is reached (matches
// update-workspace.js's findYarnLock — the sync-midstream tree always has a
// single root yarn.lock per exported workspace, one level above "plugins/"
// and any nested "workspaces/<name>" content).
function findYarnLock(packageJsonPath) {
  let dir = path.dirname(path.resolve(packageJsonPath));
  for (;;) {
    const candidate = path.join(dir, 'yarn.lock');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (path.basename(dir) === 'workspaces') {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

module.exports = {
  IGNORED_DIR_NAMES,
  findPackageJsonFiles,
  findYarnLock,
};
