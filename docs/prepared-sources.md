# Prepared Source OCI Artifacts (overlays)

Tracking: [RHIDP-15700](https://redhat.atlassian.net/browse/RHIDP-15700),
[RHIDP-15699](https://redhat.atlassian.net/browse/RHIDP-15699),
[RHDHPLAN-1568](https://redhat.atlassian.net/browse/RHDHPLAN-1568)

## Goal

Publish **per-workspace prepared source trees from this overlays repository** so
downstream can consume a stable OCI contract. Preparation is an engineering
concern and belongs here — not in midstream `sync-midstream.sh`.

## Registry contract (RHIDP-15700)

Currently pointed at a personal scratch registry
(`quay.io/polasudo/testing`) to validate the artifact format before the real
`quay.io/rhdh/prepared-sources` / `quay.io/rhdh/prepared-sources-ref`
registries are provisioned — see "Registry is temporary" below.

| Field | Value |
|-------|-------|
| Image | `quay.io/polasudo/testing` — flat repo, no nested paths |
| Tag | `<workspace>-<overlay-branch>` — mutable, overwritten each rebuild |
| Tag (pinned) | `<workspace>-<overlay-branch>-<short-overlay-commit>` — immutable |
| Artifact type | `application/vnd.rhdh.prepared-sources.v1+tar+gzip` |

Quay.io personal namespaces reject nested repository paths (`FEATURE_EXTENDED_REPOSITORY_NAMES`
is not enabled for them), so workspace/branch/commit are encoded in the tag
instead of the path. Every push writes both tags from the same tarball: the
mutable one for "latest for this workspace+branch," the pinned one so a
build stays reachable by exact commit after the mutable tag moves on.

Branch names are sanitized before use in a tag (OCI tags only allow
`[a-zA-Z0-9_.-]`): `feat/RHIDP-15700-foo` → `feat-RHIDP-15700-foo`. This
matters in practice — `workflow_dispatch` defaults `overlay-branch` to the
triggering ref name, which for a feature-branch run contains `/`.

### Annotations

Attached to both tags:

| Annotation | Meaning |
|------------|---------|
| `org.rhdh.overlay-commit` | SHA of the overlays commit used to build the tree |
| `org.rhdh.source-ref` | Upstream git ref from `workspaces/<workspace>/source.json` (`repo-ref`) |

### Example

```text
quay.io/polasudo/testing:topology-main
quay.io/polasudo/testing:topology-main-a1b2c3d
quay.io/polasudo/testing:backstage-release-1.10
quay.io/polasudo/testing:backstage-release-1.10-9f8e7d6
```

### Registry is temporary

`quay.io/polasudo/testing` is a personal namespace used only to validate the
artifact shape end-to-end. It does not change the dual-registry design from
the architecture discussion: `prepared-sources` for overlay-produced
artifacts vs. `prepared-sources-ref` for the sync-midstream reference
baseline used to diff the two pipelines during the transition. Once the
format is proven, `registry-prefix` (workflow input) /
`PREPARED_SOURCES_REF_REGISTRY` (script env var) should be pointed at
whichever real `quay.io/rhdh/...` registry applies.

## Producer workflow

`.github/workflows/publish-prepared-sources.yaml` (`workflow_dispatch`)

Per workspace:

1. Clone upstream from `source.json`
2. Apply overlays/patches (`override-sources`)
3. Ensure a hermetic, pinned Yarn binary (`scripts/prepared-sources/ensureHermeticYarn.js`)
4. `yarn install` + `yarn tsc`
5. Export dynamic plugins (`dist-dynamic`)
6. Scrub install caches / non-keeper `dist-dynamic` files
7. `oras push` via `scripts/prepared-sources/pushPreparedSourcesRef.js`

### Hermetic Yarn binary

Mirrors sync-midstream.sh's yarnPath bootstrap (`build/ci/sync-midstream.sh`,
"Ensure yarnPath is set and the Yarn binary exists"). If the workspace
doesn't already ship a working `.yarnrc.yml#yarnPath` binary, this downloads
the version pinned in `package.json#packageManager` into
`.yarn/releases/yarn-X.Y.Z.cjs`, points `yarnPath` at it, and strips
`packageManager` from `package.json` — otherwise a hermetic (network-less)
downstream build would have corepack try to fetch it and fail.

Push failures are **non-blocking by default** (`continue-on-push-error=true`,
script soft-fails unless `--strict`).

### Local / CI helper

```bash
node scripts/prepared-sources/pushPreparedSourcesRef.js \
  --dir /path/to/prepared/topology \
  --workspace topology \
  --overlay-branch main \
  --overlay-commit "$(git rev-parse HEAD)" \
  --source-json workspaces/topology/source.json \
  --dry-run
```

Requires `oras` on `PATH` and `QUAY_TOKEN` / `QUAY_USERNAME` for real pushes.

## Known gap vs midstream Loop 2/3

This producer currently mirrors overlays export CI (clone → override → yarn →
export → scrub), plus the hermetic-yarn bootstrap above. Confirmed via a
same-commit, same-environment diff against a real `sync-midstream.sh` Loop 3
run (RHIDP-15700 investigation, 2026-07-24):

- **Not ported (deliberately, out of scope here):** `update-workspace.js`
  (Loop 2) does workspace-protocol/`backstage:^` resolution, stale
  dependency-reference removal from `package.json`/`yarn.lock`, and pruning
  unneeded internal workspace packages (e.g. `app`, `app-next`, `backend`,
  `e2e-test` for the `backstage` workspace). It's a 2000+ line script doing
  real dependency-graph surgery — porting a partial slice of it risks being
  subtly wrong, so it stays tracked as its own future TypeScript-rewrite
  effort under RHDHPLAN-1568, not something to shim here.
- **Not yet ported:** Loop 3 also regenerates `dist-dynamic/yarn.lock` after
  its own `yarn install --no-immutable`; this producer's scrub step doesn't
  currently produce that file.
- **Verified NOT a gap:** the compiled `dist/`/`dist-types/` output present
  mid-pipeline in midstream gets stripped by its own later cleanup step —
  this producer omitting them by design (prepared-sources is a rebuildable
  source snapshot, not a compiled artifact) is correct, not a discrepancy.
