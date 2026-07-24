# Prepared Sources: Live Demo Script

Tracking: [RHIDP-15700](https://redhat.atlassian.net/browse/RHIDP-15700) (this producer),
[RHIDP-15701](https://redhat.atlassian.net/browse/RHIDP-15701) (planned consumer),
[RHDHPLAN-1568](https://redhat.atlassian.net/browse/RHDHPLAN-1568) (parent feature)

For the full technical reference (registry contract, annotations, known gaps), see
[`prepared-sources.md`](./prepared-sources.md). This doc is a run-it-live script for
showing the work to the team.

Branch used below: `feat/RHIDP-15700-prepared-sources-ref` on
`polasudo/rhdh-plugin-export-overlays` (a personal fork — safe to demo against, no
shared state at risk). Swap the branch/repo if presenting from elsewhere.

---

## 1. The problem (30 seconds, no commands)

Today, `sync-midstream.sh` does everything in three loops — clone, transform, re-export —
entirely inside the downstream productization repo (`rhdh-plugin-catalog`). It's slow
(single big sequential run, can't parallelize per workspace), untested, and puts source
preparation in productization's hands instead of engineering's.

The plan: move source preparation into *this* repo (the overlay), have it publish
self-contained OCI artifacts, and have downstream just pull + commit. This is step one:
**a working producer**, proven against real infrastructure, not just local dry runs.

---

## 2. Architecture at a glance

```
this repo (rhdh-plugin-export-overlays)
  workflow_dispatch → clone upstream → apply overlays → pin hermetic yarn
  → yarn install/tsc → export dynamic plugin → scrub → pack as tarball
  → oras push, two tags per build
        │
        ▼
  OCI registry (quay.io) — org.rhdh.overlay-commit / org.rhdh.source-ref
  annotations for traceability
        │
        ▼ (not built yet — RHIDP-15701)
  sync-midstream.sh "consumer mode": pull the artifact instead of running
  Loops 1-3, verify freshness, continue straight to git commit
```

---

## 3. Live: trigger the real producer workflow

```bash
gh workflow run publish-prepared-sources.yaml \
  --repo polasudo/rhdh-plugin-export-overlays \
  --ref feat/RHIDP-15700-prepared-sources-ref \
  -f workspace-path=workspaces/global-header
```

Watch it run (takes a few minutes — real `yarn install`/`tsc`/export against a real
upstream monorepo, not a mock):

```bash
gh run watch --repo polasudo/rhdh-plugin-export-overlays
```

Talking point while it runs: this is the *exact same* clone → override → yarn → export
flow the existing `export_workspaces_as_dynamic` workflow already uses in production —
we're not reinventing that part, just adding what happens after it.

---

## 4. Live: inspect the resulting artifact

```bash
# creds: personal robot account, not a shared secret — rotate before wider sharing
oras login quay.io -u polasudo+test --password-stdin <<< "$QUAY_TOKEN"

oras pull quay.io/polasudo/testing:global-header-feat-RHIDP-15700-prepared-sources-ref
tar tzf global-header.tar.gz | head -20

oras manifest fetch quay.io/polasudo/testing:global-header-feat-RHIDP-15700-prepared-sources-ref \
  | jq '.annotations'
```

Point out live:
- `org.rhdh.overlay-commit` / `org.rhdh.source-ref` annotations — this is how a future
  consumer proves an artifact isn't stale before trusting it (the freshness check in the
  RHIDP-15701 design).
- Two tags exist for every build — `<workspace>-<branch>` (mutable, "give me latest") and
  `<workspace>-<branch>-<short-sha>` (immutable, survives the mutable tag moving on):
  ```bash
  oras manifest fetch quay.io/polasudo/testing:global-header-feat-RHIDP-15700-prepared-sources-ref-<short-sha> | jq .
  ```

---

## 5. Talking points: what's been battle-tested, not just written

Everything below was found by actually running things end-to-end against real
infrastructure — not assumed from reading code:

- **Three real bugs found and fixed via live CI runs**: an invalid pinned SHA for a
  GitHub Action, `oras`'s path-validation rejecting our temp file (which also leaked the
  local machine's temp path into a published annotation), and OCI tag validation
  rejecting branch names containing `/` (any real feature-branch run would have hit this).
- **Reproducing sync-midstream.sh locally failed for reasons that turned out to be
  environmental, not real bugs**: this Mac is Apple Silicon, the real CI runner is
  Linux x86_64 with far more memory than the default local container VM — same
  workspace, same commit, ran clean once matched to the real environment (Linux
  container, bumped memory). Good example of "verify before concluding it's broken."
- **A real content gap found via diffing against sync-midstream's actual Loop 3
  output**: our artifacts were missing a properly pinned Yarn binary. Traced to
  sync-midstream's own "flatten" step, which copies a root-level checked-in Yarn binary
  into each workspace — not documented anywhere, found by tracing the actual bash. Fixed
  and reverified with a second live CI run.

---

## 6. Live: Loop 2 parity progress

The remaining known gap is midstream's "Loop 2" (`update-workspace.js`, 2445 lines, zero
existing tests) — dependency-reference cleanup and workspace-protocol resolution. Instead
of porting it wholesale, it's being rebuilt as small, independently tested modules based
on a full trace of what the original actually does.

```bash
node --test scripts/prepared-sources/transforms/*.test.js
```

50 passing tests. Highlight: the yarn.lock parser here already **fixes a real bug** in
the 2445-line original — it only matched the first spec in a combined multi-spec yarn.lock
key, so a delete targeting a package listed *second* in a combined key would silently miss
it. Ours checks every spec.

```bash
ls scripts/prepared-sources/transforms/
```
- `yarnLockBlocks.js` / `fsWalk.js` — shared foundation (one parser instead of three
  duplicated hand-rolled ones in the original)
- `removePatches.js` — strips internal fork patch resolutions
- `pruneUnneededPackages.js` — strips dangling dependency references to removed packages

---

## 7. What's next

- **Module D** (workspace:/backstage:^ resolution) — the largest, highest-risk piece,
  deliberately last.
- **Module E** (type-shims generation) — build only after confirming with a real diff
  that our producer's output actually needs it.
- **Wire modules A-C into the real workflow** once proven standalone.
- **RHIDP-15701** (consumer mode in `sync-midstream.sh`) — design is done, ready to build
  once producer parity is far enough along; branch is explicitly not-for-merge until this
  producer is proven equivalent.
