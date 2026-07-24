#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  Loop 2 parity, Module A: a small, well-tested yarn.lock (Berry v2+) entry
  parser, replacing the hand-rolled indentation-heuristic state machine
  duplicated three times in midstream's build/scripts/update-workspace.js
  (deleteFromYarnLock, removePatchesFromYarnLock, updateYarnLock).

  Block boundary rule (verified against the original): a line starting with
  `"` at column 0 begins a new entry; any indented or blank line belongs to
  the entry above it. Everything before the first such line (comments,
  `__metadata:`) is kept as an opaque preamble.
*/

'use strict';

// Split yarn.lock content into a preamble (everything before the first
// entry) and an ordered list of { key, lines } blocks. `key` is the raw
// key line (still quoted, still ending in ":"); `lines` includes the key
// line itself plus every line belonging to that entry. Concatenating
// preamble + all blocks' lines with '\n' reproduces the input exactly.
function parseYarnLockBlocks(content) {
  const lines = content.split('\n');
  const preamble = [];
  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('"')) {
      if (current) {
        blocks.push(current);
      }
      current = { key: line, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) {
    blocks.push(current);
  }

  return { preamble, blocks };
}

function serializeYarnLockBlocks({ preamble, blocks }) {
  const parts = [...preamble];
  for (const block of blocks) {
    parts.push(...block.lines);
  }
  return parts.join('\n');
}

// A block's key line looks like:
//   "pkg@npm:^1.0.0":
//   "pkg@workspace:^, pkg@workspace:plugins/foo":
// Extract the comma-separated specs (package@protocol:range fragments).
function parseKeySpecs(keyLine) {
  const stripped = keyLine.replace(/^"/, '').replace(/":\s*$/, '');
  return stripped.split(', ').map((s) => s.trim());
}

// Matches update-workspace.js's convention: the literal package name
// "@internal/ANY" is a wildcard for "any @internal/* package" (used to bulk
// -clean internal workspace packages). Otherwise, an exact package name
// anchored at the start of a spec (before its "@<protocol>:" suffix).
function nameToPattern(packageName) {
  if (packageName === '@internal/ANY') {
    return /^@internal\//;
  }
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}@`);
}

// True if any comma-separated spec in the block's key matches packageName
// (checks every spec, not just the first — a real fix vs. the original,
// which only anchored against the whole key line and so missed matches on
// non-first specs in a combined key).
function blockMatchesPackage(block, packageName) {
  const pattern = nameToPattern(packageName);
  return parseKeySpecs(block.key).some((spec) => pattern.test(spec));
}

function blockMatchesAnyPackage(block, packageNames) {
  return packageNames.some((name) => blockMatchesPackage(block, name));
}

// Shared primitive: remove every block matching any of packageNames from
// yarn.lock content. Used by both the remove-patches and unneeded-package
// -pruning transforms (Modules B and C) — in the original these were two
// separate, near-identical hand-rolled loops.
function deleteYarnLockBlocksByPackageNames(content, packageNames) {
  const parsed = parseYarnLockBlocks(content);
  const removed = [];
  const keptBlocks = parsed.blocks.filter((block) => {
    if (blockMatchesAnyPackage(block, packageNames)) {
      removed.push(block.key);
      return false;
    }
    return true;
  });
  const newContent = serializeYarnLockBlocks({ preamble: parsed.preamble, blocks: keptBlocks });
  return { content: newContent, removed };
}

module.exports = {
  parseYarnLockBlocks,
  serializeYarnLockBlocks,
  parseKeySpecs,
  nameToPattern,
  blockMatchesPackage,
  blockMatchesAnyPackage,
  deleteYarnLockBlocksByPackageNames,
};
