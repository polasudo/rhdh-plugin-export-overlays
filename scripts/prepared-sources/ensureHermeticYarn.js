#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  RHIDP-15700: Ensure a workspace has a self-contained, pinned Yarn binary
  before install/export, mirroring sync-midstream.sh's handling of Yarn
  (build/ci/sync-midstream.sh):

  1. The "flatten" step (lines ~780-805) copies the monorepo root's
     .yarnrc.yml + checked-in .yarn/releases/*.cjs binary into each
     per-workspace output folder — most workspaces (repo-flat: false) don't
     ship their own .yarnrc.yml/yarnPath at all, only the monorepo root
     does. Our sparse-checkout already fetches the root's .yarnrc.yml/.yarn
     into the repo root (not the plugins-root subdirectory yarn actually
     runs in), so this mirrors that copy.
  2. The yarnPath bootstrap (lines ~1186-1210) is the fallback for when
     step 1 doesn't apply (e.g. no repo root available, or the root itself
     has no checked-in binary): derive the version from
     package.json#packageManager and download it from repo.yarnpkg.com.
  3. Either way, packageManager gets stripped from package.json afterwards
     (lines ~1212-1218) — otherwise a hermetic (network-less) downstream
     build would have corepack try to fetch it and fail.
*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function logInfo(msg) {
  console.log(`[INFO] ${msg}`);
}

function logWarn(msg) {
  console.warn(`[WARN] ${msg}`);
}

function usage() {
  return `Ensure a hermetic, pinned Yarn binary for a workspace (RHIDP-15700).

Usage:
  node ensureHermeticYarn.js --dir PATH [--repo-root PATH]

Options:
  --dir PATH        Workspace root containing package.json (required)
  --repo-root PATH  Monorepo clone root to copy a root-level pinned Yarn
                     binary from, if the workspace doesn't ship its own
                     (optional — falls back to downloading from
                     packageManager if omitted or not usable)
  -h, --help        Show this help
`;
}

function parseArgs(argv) {
  const opts = { dir: '', repoRoot: '', help: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--dir':
        opts.dir = path.resolve(args.shift());
        break;
      case '--repo-root':
        opts.repoRoot = path.resolve(args.shift());
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readYarnPath(yarnrcPath) {
  if (!fs.existsSync(yarnrcPath)) {
    return '';
  }
  const match = fs.readFileSync(yarnrcPath, 'utf8').match(/^yarnPath:\s*(.+)\s*$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

function setYarnPath(yarnrcPath, yarnPathValue) {
  let content = fs.existsSync(yarnrcPath) ? fs.readFileSync(yarnrcPath, 'utf8') : '';
  if (/^yarnPath:/m.test(content)) {
    content = content.replace(/^yarnPath:.*$/m, `yarnPath: ${yarnPathValue}`);
  } else {
    content += `${content && !content.endsWith('\n') ? '\n' : ''}yarnPath: ${yarnPathValue}\n`;
  }
  fs.writeFileSync(yarnrcPath, content);
}

function hasWorkingYarnPath(dir) {
  const yarnPathValue = readYarnPath(path.join(dir, '.yarnrc.yml'));
  return Boolean(yarnPathValue) && fs.existsSync(path.join(dir, yarnPathValue));
}

// Mirrors sync-midstream.sh's flatten step: copy a root-level, checked-in
// Yarn binary into the workspace instead of downloading one.
function copyYarnFromRepoRoot(dir, repoRoot) {
  const rootYarnrc = path.join(repoRoot, '.yarnrc.yml');
  const rootYarnPathValue = readYarnPath(rootYarnrc);
  if (!rootYarnPathValue) {
    return false;
  }
  const rootBinary = path.join(repoRoot, rootYarnPathValue);
  if (!fs.existsSync(rootBinary)) {
    return false;
  }
  const destBinary = path.join(dir, rootYarnPathValue);
  fs.mkdirSync(path.dirname(destBinary), { recursive: true });
  fs.copyFileSync(rootBinary, destBinary);
  setYarnPath(path.join(dir, '.yarnrc.yml'), rootYarnPathValue);
  logInfo(`Copied yarn binary from repo root: ${rootYarnPathValue}`);
  return true;
}

async function downloadYarnBinary(version, destPath) {
  const url = `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`;
  logInfo(`Downloading yarn ${version} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download yarn ${version}: HTTP ${res.status}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, body);
}

function readPackageManager(dir, repoRoot) {
  const own = readJson(path.join(dir, 'package.json')).packageManager || '';
  if (own) {
    return own;
  }
  if (repoRoot) {
    const rootPackageJson = path.join(repoRoot, 'package.json');
    if (fs.existsSync(rootPackageJson)) {
      return readJson(rootPackageJson).packageManager || '';
    }
  }
  return '';
}

async function downloadYarnFromPackageManager(dir, repoRoot) {
  const pkgManager = readPackageManager(dir, repoRoot);
  const versionMatch = /^yarn@(\d+\.\d+\.\d+)/.exec(pkgManager);
  if (!versionMatch) {
    throw new Error(
      `No yarnPath in .yarnrc.yml and no yarn packageManager in package.json (got: ${JSON.stringify(pkgManager)})`,
    );
  }
  const yarnVersion = versionMatch[1];
  const relativeBinary = `.yarn/releases/yarn-${yarnVersion}.cjs`;
  await downloadYarnBinary(yarnVersion, path.join(dir, relativeBinary));
  setYarnPath(path.join(dir, '.yarnrc.yml'), relativeBinary);
  logInfo(`Set yarnPath to ${relativeBinary} (from packageManager: ${pkgManager})`);
}

function removePackageManager(packageJsonPath) {
  const pkg = readJson(packageJsonPath);
  if (pkg.packageManager === undefined) {
    return false;
  }
  logWarn('Removing package.json#packageManager to support hermetic builds');
  delete pkg.packageManager;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

async function ensureHermeticYarn(dir, repoRoot) {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found: ${packageJsonPath}`);
  }

  if (hasWorkingYarnPath(dir)) {
    logInfo(`Yarn binary already pinned: ${readYarnPath(path.join(dir, '.yarnrc.yml'))}`);
  } else if (
    repoRoot &&
    path.resolve(repoRoot) !== path.resolve(dir) &&
    copyYarnFromRepoRoot(dir, repoRoot)
  ) {
    // handled, logged inside copyYarnFromRepoRoot
  } else {
    await downloadYarnFromPackageManager(dir, repoRoot);
  }

  removePackageManager(packageJsonPath);
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    console.log(usage());
    return 1;
  }

  if (opts.help) {
    console.log(usage());
    return 0;
  }

  if (!opts.dir) {
    console.error('[ERROR] --dir is required');
    console.log(usage());
    return 1;
  }

  try {
    await ensureHermeticYarn(opts.dir, opts.repoRoot);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }

  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  parseArgs,
  readYarnPath,
  setYarnPath,
  hasWorkingYarnPath,
  copyYarnFromRepoRoot,
  removePackageManager,
  ensureHermeticYarn,
  main,
};
