#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  RHIDP-15700: Ensure a workspace has a self-contained, pinned Yarn binary
  before install/export, mirroring sync-midstream.sh's yarnPath bootstrap
  (build/ci/sync-midstream.sh, "Ensure yarnPath is set and the Yarn binary
  exists").

  Why: hermetic builds (Konflux) have no network access, so relying on
  corepack to fetch a Yarn version from package.json#packageManager at
  install time doesn't work downstream. If the workspace doesn't already
  ship a valid .yarnrc.yml#yarnPath binary, this downloads the pinned
  version (derived from packageManager) into .yarn/releases/ and points
  yarnPath at it, then strips packageManager from package.json so nothing
  downstream tries to trigger a corepack network fetch again.

  If the workspace already ships a working yarnPath binary, this is a
  no-op (except still removing packageManager, for consistency).
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
  node ensureHermeticYarn.js --dir PATH

Options:
  --dir PATH   Workspace root containing package.json (required)
  -h, --help   Show this help
`;
}

function parseArgs(argv) {
  const opts = { dir: '', help: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--dir':
        opts.dir = path.resolve(args.shift());
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

async function ensureHermeticYarn(dir) {
  const packageJsonPath = path.join(dir, 'package.json');
  const yarnrcPath = path.join(dir, '.yarnrc.yml');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found: ${packageJsonPath}`);
  }

  const existingYarnPath = readYarnPath(yarnrcPath);
  const existingBinary = existingYarnPath ? path.join(dir, existingYarnPath) : '';

  if (existingYarnPath && fs.existsSync(existingBinary)) {
    logInfo(`Yarn binary already pinned: ${existingYarnPath}`);
  } else {
    const pkg = readJson(packageJsonPath);
    const pkgManager = pkg.packageManager || '';
    const versionMatch = /^yarn@(\d+\.\d+\.\d+)/.exec(pkgManager);
    if (!versionMatch) {
      throw new Error(
        `No yarnPath in .yarnrc.yml and no yarn packageManager in package.json (got: ${JSON.stringify(pkgManager)})`,
      );
    }
    const yarnVersion = versionMatch[1];
    const relativeBinary = `.yarn/releases/yarn-${yarnVersion}.cjs`;
    await downloadYarnBinary(yarnVersion, path.join(dir, relativeBinary));
    setYarnPath(yarnrcPath, relativeBinary);
    logInfo(`Set yarnPath to ${relativeBinary} (from packageManager: ${pkgManager})`);
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
    await ensureHermeticYarn(opts.dir);
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
  removePackageManager,
  ensureHermeticYarn,
  main,
};
