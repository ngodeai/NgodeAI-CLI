# Upstream Sync (OMP → NgodeAI)

NgodeAI is a rebranded fork of [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP).
Upstream moves fast — roughly 6,000 commits between minor releases — so this repo
syncs **one upstream release at a time**, never by merging upstream history.

The invariant: **no OMP brand token survives in the tree**. `scripts/check-branding.ts`
enforces it; see [Brand guard](#brand-guard).

## Fork point

| | |
| --- | --- |
| Upstream commit | `0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0` |
| Upstream tag | `v18.12.6` + 170 commits (`git describe` → `v18.12.6-170-g0b5c27ab24`) |
| Upstream date | 2026-10-22 |
| NgodeAI release | `v1.0.9` (2026-11-18) |

This is a content fork, not a history fork: upstream commits are not in this repo's
object database. Update the table above after every sync — it is the only record of
what the working tree was actually cut from.

## Current gap

Upstream `v18.22.0` (2026-11-16) is **6,286 commits** ahead of the fork point and
touches 5,669 files. Release ladder with per-step commit counts, measured from the
fork point:

| Target tag | Date | Commits since previous step | Cumulative |
| --- | --- | ---: | ---: |
| `v18.13.0` | 2026-10-26 | 433 | 433 |
| `v18.14.0` | 2026-10-29 | 1,180 | 1,613 |
| `v18.15.0` | 2026-11-01 | 629 | 2,242 |
| `v18.16.0` | 2026-11-02 | 257 | 2,499 |
| `v18.17.0` | 2026-11-06 | 660 | 3,159 |
| `v18.18.0` | 2026-11-07 | 132 | 3,291 |
| `v18.19.0` | 2026-11-12 | 1,592 | 4,883 |
| `v18.20.0` | 2026-11-13 | 614 | 5,497 |
| `v18.21.0` | 2026-11-16 | 749 | 6,246 |
| `v18.22.0` | 2026-11-16 | 40 | 6,286 |

Do not jump straight to `v18.22.0`. Each row is one sync PR; the ladder above is the
order, and the commit counts tell you where the risk is (`v18.19.0` and `v18.14.0`
are the heavy ones).

Changed files per area between the fork point and `v18.22.0`, which is also the
review order (bottom-up: cheap and independent first):

| Area | Files |
| --- | ---: |
| `packages/coding-agent` | 2,025 |
| `crates/pi-shell` | 829 |
| `packages/tui` | 526 |
| `crates/vendor` | 426 |
| `packages/ai` | 382 |
| `crates/pi-builtins` | 248 |
| `packages/catalog` | 186 |
| `packages/omptype` | 170 |
| `crates/pi-natives` | 141 |
| `packages/stats` | 83 |
| `packages/utils` | 71 |
| `packages/agent`, `crates/pi-edit` | 47 each |
| `crates/pi-walker` | 43 |
| `packages/mnemopi` | 33 |
| `docs/tools` | 32 |
| `python/robomp` | 26 |
| `packages/natives`, `packages/collab-web` | 25, 21 |

## Rename map

Upstream names never land verbatim. Every sync applies this map, in this order
(longest, most specific token first — `ngodebot` must not degrade into `robo-ngode`).

| Upstream | NgodeAI |
| --- | --- |
| `oh-my-pi`, `oh my pi`, `OhMyPi` | `NgodeAI` |
| `@oh-my-pi/pi-*` | `@ngodeai/*` |
| `crates/pi-*` | `crates/ngode-*` |
| `packages/omptype` | `packages/ngodetype` |
| `python/robomp`, `Dockerfile.robomp` | `python/ngodebot`, `Dockerfile.ngodebot` |
| `scripts/link-omp.sh` | `scripts/link-ngodeai.sh` |
| `.omp/` (repo config root) | `.ngodeai/` |
| `~/.omp`, `.omp` (config dir) | `~/.ngodeai`, `.ngodeai` |
| `__omp*` (globals, worker argv, napi exports) | `__ngode*` |
| `Omp*` (types, classes) | `Ngode*` |
| `omp.sh`, `*.omp.sh` | `ngodeai.net`, `*.ngodeai.net` |
| `can1357/oh-my-pi`, `can1357/ngodeai` | `ngodeai/NgodeAI-CLI` |

Two deliberate exceptions, both enforced by the guard's exception table:

- `LEGACY_CONFIG_DIR_NAMES` keeps `".omp"` — the one-way first-run migration of
  pre-rebrand config roots. Renaming it orphans existing installs.
- `__omp_judgment_images` stays — it is the TypeSafe request key the deployed
  gateway reads. Renaming it needs a coordinated gateway change.

## Procedure

1. **Pick one target tag** from the ladder. Record it in the fork-point table only
   after the sync PR merges.
2. **Fetch that tag bloblessly** into a scratch clone — never into this repo:

   ```bash
   git clone --bare --filter=blob:none --no-checkout https://github.com/can1357/oh-my-pi /tmp/omp
   git -C /tmp/omp diff --name-status <previous-tag> <target-tag>
   ```

3. **Slice by area** from the table above, one commit per slice. Port the *diff*,
   never the file wholesale: a full-file copy reverts every NgodeAI-only feature in
   that file.
4. **Apply the rename map** to the slice before committing. `scripts/check-branding.ts`
   fails the commit otherwise.
5. **Rebuild what the slice touches**:
   - napi export renamed → rebuild the native addon
     (`bun scripts/bazel-natives.ts <target> --dest packages/natives/native`). A stale
     addon still carries the old stamp, loads cleanly, and silently skips the renamed
     hook.
   - `packages/catalog/src/models.json` and `compat/rules.json` are generated — port the
     generator inputs, then run `bun run gen:models` / `bun run gen:compat`.
   - prompt or schema change → check the `.md`/`.json` fixtures the guard lists as
     captured upstream data.
6. **Verify** with the narrowest tests for the slice, then `bun run check:branding`
   and `bun run check:ts`.
7. **Release** as a minor bump once the slice is green; the ladder is the changelog
   skeleton.

## Brand guard

```bash
bun run check:branding        # gate: fails on any unreviewed brand token
bun scripts/check-branding.ts --list   # the exception table
```

It scans `git ls-files` output, skipping vendored code (`crates/vendor/**`), generated
lockfiles, and captured fixtures. Rules cover the product name, the bare `omp` word,
`omp`-prefixed identifiers, config paths and domains, the npm scope, and dead upstream
repo paths. English words that merely contain the letters (`prompt`, `compact`,
`completion`) never match, and `OMP_NUM_THREADS` / `OMP_THREAD_LIMIT` are OpenMP, not
this project's brand.

An exception is a reviewed decision with a `reason`, not a suppression. Adding one
requires that the token be externally fixed: a legal attribution, a migration path, a
wire contract owned by a deployed service, or an external protocol name.
