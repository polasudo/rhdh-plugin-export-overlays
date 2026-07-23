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
3. `yarn install` + `yarn tsc`
4. Export dynamic plugins (`dist-dynamic`)
5. Scrub install caches / non-keeper `dist-dynamic` files
6. `oras push` via `scripts/prepared-sources/pushPreparedSourcesRef.js`

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
export → scrub). Midstream `update-workspace.js` (Loop 2) and Loop 3 drift
validation are **not** ported yet — track under RHDHPLAN-1568 follow-ups so
artifacts become fully Konflux-ready without further midstream mutation.
