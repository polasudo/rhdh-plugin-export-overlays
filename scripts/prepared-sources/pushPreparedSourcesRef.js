#!/usr/bin/env node
/*
  Copyright (c) Red Hat, Inc.

  RHIDP-15700: Push a prepared workspace source tree as an OCI artifact from
  the overlays repo.

  Artifact (flat repo — quay.io personal namespaces reject nested repo
  paths — workspace/branch/commit are encoded in the tag instead):
    ${PREPARED_SOURCES_REF_REGISTRY:-quay.io/polasudo/testing}:<workspace>-<overlay-branch>
    ${PREPARED_SOURCES_REF_REGISTRY:-quay.io/polasudo/testing}:<workspace>-<overlay-branch>-<short-overlay-commit>

  The first tag is mutable (overwritten on each rebuild); the second is an
  immutable, commit-pinned pointer so older builds stay reachable after the
  mutable tag moves on.

  Annotations (attached to both tags):
    org.rhdh.overlay-commit — overlay commit SHA
    org.rhdh.source-ref     — source.json "repo-ref"

  Shells out for tar/oras. Soft-fail by default (exit 0) so publish pipelines
  are not blocked; pass --strict to fail on push errors.
*/

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_REGISTRY = 'quay.io/polasudo/testing';
const SHORT_SHA_LENGTH = 7;
const ARTIFACT_TYPE = 'application/vnd.rhdh.prepared-sources.v1+tar+gzip';
const LAYER_MEDIA_TYPE = 'application/vnd.oci.image.layer.v1.tar+gzip';

// OCI/Docker tags must match [a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}. Branch names
// like "feat/RHIDP-15700-foo" contain "/", which is invalid in a tag (only
// valid in a repo *path*, and this registry is flat/no-nested-paths anyway).
function sanitizeTagComponent(raw) {
  let s = String(raw || '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^[.-]+/, '');
  return s || 'unknown';
}

function logInfo(msg) {
  console.log(`[INFO] ${msg}`);
}

function logWarn(msg) {
  console.warn(`[WARN] ${msg}`);
}

function logError(msg) {
  console.error(`[ERROR] ${msg}`);
}

function usage() {
  return `Push prepared-source reference OCI artifacts from overlays (RHIDP-15700).

Usage:
  node pushPreparedSourcesRef.js [options]

Options:
  --dir PATH              Prepared source tree to pack (required)
  --workspace NAME        Workspace name used in the tag (required)
  --overlay-branch NAME   Branch used in the tag (required, or $OVERLAY_BRANCH)
  --overlay-commit SHA    org.rhdh.overlay-commit (required, or $OVERLAY_COMMIT)
                          also used to derive the immutable commit-pinned tag
  --source-ref REF        org.rhdh.source-ref (or read from --source-json)
  --source-json PATH      Path to workspaces/<ws>/source.json
  --registry URL          Flat registry/repo (default: ${DEFAULT_REGISTRY}
                          or $PREPARED_SOURCES_REF_REGISTRY) — no nested
                          paths; workspace/branch/commit go in the tag
  --dry-run               Log oras command without pushing
  --strict                Exit non-zero on failure (default: soft-fail / exit 0)
  -h, --help              Show this help

Environment:
  OVERLAY_BRANCH, OVERLAY_COMMIT, PREPARED_SOURCES_REF_REGISTRY
  QUAY_TOKEN / QUAY_USER (or QUAY_USERNAME) for oras login
`;
}

function parseArgs(argv) {
  const opts = {
    dir: '',
    workspace: '',
    overlayBranch: process.env.OVERLAY_BRANCH || '',
    overlayCommit: process.env.OVERLAY_COMMIT || '',
    sourceRef: '',
    sourceJson: '',
    registry: process.env.PREPARED_SOURCES_REF_REGISTRY || DEFAULT_REGISTRY,
    dryRun: false,
    strict: false,
    help: false,
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--dir':
        opts.dir = path.resolve(args.shift());
        break;
      case '--workspace':
        opts.workspace = String(args.shift() || '')
          .replace(/^workspaces\//, '')
          .replace(/\/$/, '');
        break;
      case '--overlay-branch':
        opts.overlayBranch = args.shift();
        break;
      case '--overlay-commit':
        opts.overlayCommit = args.shift();
        break;
      case '--source-ref':
        opts.sourceRef = args.shift();
        break;
      case '--source-json':
        opts.sourceJson = path.resolve(args.shift());
        break;
      case '--registry':
        opts.registry = args.shift();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--strict':
        opts.strict = true;
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

function readSourceRef(sourceJsonPath) {
  const raw = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'));
  const ref = raw['repo-ref'];
  if (!ref || typeof ref !== 'string') {
    return '';
  }
  return ref;
}

function commandExists(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(cmd)}`], {
    encoding: 'utf8',
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
    env: options.env || process.env,
    input: options.input,
    cwd: options.cwd,
  });
}

function ensureOrasLogin(dryRun) {
  if (dryRun) {
    return true;
  }
  if (!process.env.QUAY_TOKEN) {
    logWarn('QUAY_TOKEN not set — cannot login to quay.io');
    return false;
  }
  const quayUser =
    process.env.QUAY_USER || process.env.QUAY_USERNAME || 'rhdh+rhdh_bot';
  logInfo(`Logging into quay.io as ${quayUser} (oras)`);
  const login = spawnSync(
    'oras',
    ['login', 'quay.io', '-u', quayUser, '--password-stdin'],
    {
      input: process.env.QUAY_TOKEN,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  return login.status === 0;
}

function finish(ok, strict, message) {
  if (!ok && message) {
    logWarn(message);
  }
  if (!ok && strict) {
    return 1;
  }
  return 0;
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    logError(err.message);
    console.log(usage());
    return 1;
  }

  if (opts.help) {
    console.log(usage());
    return 0;
  }

  if (!opts.dir || !opts.workspace || !opts.overlayBranch || !opts.overlayCommit) {
    logError('--dir, --workspace, --overlay-branch, and --overlay-commit are required');
    console.log(usage());
    return finish(false, opts.strict);
  }

  let sourceRef = opts.sourceRef;
  if (!sourceRef && opts.sourceJson) {
    try {
      sourceRef = readSourceRef(opts.sourceJson);
    } catch (err) {
      return finish(false, opts.strict, `Failed to read source.json: ${err.message}`);
    }
  }
  if (!sourceRef) {
    return finish(
      false,
      opts.strict,
      'source-ref unset — pass --source-ref or --source-json with repo-ref',
    );
  }

  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    return finish(false, opts.strict, `Prepared source dir missing: ${opts.dir}`);
  }

  if (!commandExists('tar')) {
    return finish(false, opts.strict, 'tar is required on PATH');
  }
  if (!commandExists('oras')) {
    return finish(false, opts.strict, 'oras is required on PATH');
  }

  const tagBase = `${sanitizeTagComponent(opts.workspace)}-${sanitizeTagComponent(opts.overlayBranch)}`;
  const shortSha = opts.overlayCommit.slice(0, SHORT_SHA_LENGTH);
  const mutableRef = `${opts.registry}:${tagBase}`;
  const pinnedRef = `${opts.registry}:${tagBase}-${shortSha}`;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-sources-ref.'));
  const tarballName = `${opts.workspace}.tar.gz`;
  const tarball = path.join(tmpdir, tarballName);

  logInfo(`Packing prepared sources → ${mutableRef} / ${pinnedRef}`);
  logInfo(`  overlay-commit=${opts.overlayCommit}`);
  logInfo(`  source-ref=${sourceRef}`);

  const tar = run(
    'tar',
    [
      '-C',
      opts.dir,
      '--exclude=.git',
      '--exclude=./.git',
      '--exclude=node_modules',
      '--exclude=./node_modules',
      '--exclude=.yarn/cache',
      '--exclude=./.yarn/cache',
      '-czf',
      tarball,
      '.',
    ],
    { stdio: 'pipe' },
  );
  if (tar.status !== 0) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    return finish(false, opts.strict, `tar failed: ${tar.stderr || tar.stdout || ''}`.trim());
  }

  const orasArgsFor = (ref) => [
    'push',
    ref,
    '--artifact-type',
    ARTIFACT_TYPE,
    '--annotation',
    `org.rhdh.overlay-commit=${opts.overlayCommit}`,
    '--annotation',
    `org.rhdh.source-ref=${sourceRef}`,
    // Relative path (oras run with cwd=tmpdir below) avoids both oras's
    // absolute-path safety check and leaking the local tmp path into the
    // pushed layer's org.opencontainers.image.title annotation.
    `${tarballName}:${LAYER_MEDIA_TYPE}`,
  ];

  const refs = [mutableRef, pinnedRef];

  if (opts.dryRun) {
    for (const ref of refs) {
      console.log(`[DRY-RUN] oras ${orasArgsFor(ref).join(' ')}`);
    }
    fs.rmSync(tmpdir, { recursive: true, force: true });
    return 0;
  }

  if (!ensureOrasLogin(false)) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    return finish(false, opts.strict, 'oras login failed');
  }

  for (const ref of refs) {
    const push = run('oras', orasArgsFor(ref), { cwd: tmpdir });
    if (push.status !== 0) {
      fs.rmSync(tmpdir, { recursive: true, force: true });
      return finish(false, opts.strict, `oras push failed for ${ref}`);
    }
    logInfo(`Pushed ${ref}`);
  }

  fs.rmSync(tmpdir, { recursive: true, force: true });
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  parseArgs,
  readSourceRef,
  sanitizeTagComponent,
  main,
  DEFAULT_REGISTRY,
};
