# Residual Pre-Rebrand Branding Audit — `pi` → `NgodeAI`

Scope: `packages/*/src`, `packages/*/scripts`, `scripts`, `crates`, `sdk`, `python`, `docs`, `.github`, `nix`, `Dockerfile*`, root `*.json`/`*.toml`/`*.kdl`/`*.nix`/`*.md`.
Excluded per task: `node_modules`, `bun.lock`, `Cargo.lock`, `MODULE.bazel.lock`, `THIRD-PARTY-NOTICES.txt`, `crates/vendor/**`, `assets/**`, `*.patch`, `.wt/**`, `.review-home/**`, `.git/**` (plus build output `packages/*/dist/**`, which is generated).

Read-only audit. No files other than this report were created or modified.

---

## 1. Confirmed old-brand tokens

Determined from the artifacts, not guessed:

| Evidence | Shows |
| --- | --- |
| `scripts/release.ts:3` | `* Release script for pi-mono` |
| `docs/porting-from-pi-mono.md:1` | `# Porting From pi-mono: A Practical Merge Guide` |
| `docs/user-facing-packages.md:53` | shallow-clones `badlogic/pi-mono` |
| `packages/tui/src/utils.ts:442` | `Copied verbatim from pi-mono \`packages/tui/src/utils.ts\`` |
| `packages/utils/src/env.ts:266-272` | "`PI_*` survives as the single legacy prefix"; `LEGACY_ENV_PREFIXES = ["PI_"]` |
| `packages/utils/src/dirs.ts:40` | `LEGACY_CONFIG_DIR_NAMES = [".omp", ".pi"]` |
| `README.md` (all) | already fully `NgodeAI` / `@ngodeai/` / `~/.ngodeai/` — rebrand target confirmed |

**Old brand:** `pi` / `pi-mono` (monorepo), npm scope `@pi/*` (and skins `@mariozechner/*`, `@earendil-works/*`), config dir `.pi/`, home `~/.pi/`, env prefix `PI_`.

**New brand (canonical):** `ngodeai` binary, `@ngodeai/*`, `~/.ngodeai`, `NGODEAI_` env prefix, `.ngodeai/` config dir.

Tokens swept: `pi-mono`, `@pi/`, `.pi/`, `~/ .pi/`, `PI_[A-Z0-9_]+`, `ngodeai/pi`, `pi-image`, `pi-coding-agent`, `pi-tui`, `pi:image`, `pi:run`.

### Key finding that drives classification

`packages/utils/src/env.ts:258-300` establishes the *intended* end state:

> Canonical env prefix. `NGODEAI_FOO` is the only documented spelling.
> `PI_*` survives as the single legacy prefix because third-party plugins and older shells still export it.

`mirrorEnvAliases()` runs once at import time on `Bun.env` (`env.ts:345`) and copies each `NGODEAI_<X>` to `PI_<X>` **only when the alias is unset**. Consequences:

- **Canonical `NGODEAI_<X>` writes work for every reader** (the alias is mirrored for it).
- **`PI_*` is a one-way compat alias** — it is the *fallback*, never the documented spelling.

So: `PI_*` appearing as an *internal code read or a documented alias* = INTENTIONAL; `PI_*` appearing as the **primary user-facing spelling** (docs, `--help`, install scripts, published image name) = MUST FIX.

**`ngodebot` is NOT an old-brand token.** `python/ngodebot/` is a live, self-named product ("Self-hosted GitHub triage bot", `python/ngodebot/README.md:1`) with its own `NGODEBOT_*` env prefix. Every `ngodebot` hit (≈1,050 lines, mostly `python/ngodebot/tests/*`) is correctly branded and was excluded from the counts below.

---

## 2. Summary counts per area

| Area | Files w/ hits | Hit lines | MUST FIX rows |
| --- | --- | --- | --- |
| Code (TS/Rust/Go/Python, non-test) | 137 | 532 | 4 (1 bug + 3 user-visible) |
| Config (root `package.json`, `Dockerfile*`) | 3 | 8 | 8 |
| Docs (`docs/**/*.md`, incl. `docs/tools/`, `docs/skills/`) | 63 | 291 | 45 |
| Install scripts (`scripts/install.sh`, `install.ps1`) | 2 | 6 | 4 |
| SDK (`sdk/go`, `sdk/rust`) | 2 | 4 | 0 |
| Env (documented `PI_*` vars) | 40 doc files | 119 unique vars | (counted in docs) |
| Root `.md` (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`) | 0 | 0 | 0 |
| `.github/`, `nix/`, `*.nix`, `*.toml`, `*.kdl` | 0 | 0 | 0 |
| `python/` (excl. `ngodebot` product name) | 0 | 0 | 0 |

Total MUST FIX rows: **61 path:line citations spanning 105 distinct `path:line` tokens** (expand the multi-token rows in §3c/§3d: 5 in `help-extra.ts`, 3 in `launch-help.ts`, and the ~55 `PI_*` lines in `docs/`).

Counted by row as written in §3: **8 (config) + 4 (install) + 4 (code) + 45 (docs) = 61**.

The `docs` surface is best handled as **one mechanical substitution**: 63 files, 119 unique `PI_*` vars, 291 lines — plus 3 hand-fixes where the rebrand mangled a sentence.

Notes on the code column: of the 137 files, the overwhelming majority are **internal reads of the legacy alias** (e.g. `$env.PI_NO_PTY`, `std::env::var_os("PI_CONFIG_DIR")`) which keep working because `NGODEAI_*` is mirrored onto them. Only the rows listed in §3 are breakage:
one genuine rebrand-mangling bug, and three places where `PI_*` is what a developer/user actually types.

---

## 3. MUST FIX

### 3a. Config & container image (8)

| Path:line | Token | Suggested replacement |
| --- | --- | --- |
| `package.json:78` | `PI_TIMING=x` in `dev:timing` | `NGODEAI_TIMING=x` |
| `package.json:138` | script name `pi:image`; `${PI_IMAGE:-ngodeai/pi:dev}` | script `ngodeai:image`; `${NGODEAI_IMAGE:-ngodeai/ngodeai:dev}` |
| `package.json:139` | script name `pi:run`; `${PI_IMAGE:-ngodeai/pi:dev}` | script `ngodeai:run`; `${NGODEAI_IMAGE:-ngodeai/ngodeai:dev}` |
| `package.json:140` | `bun run pi:image` | `bun run ngodeai:image` |
| `package.json:141` | `bun run pi:image` | `bun run ngodeai:image` |
| `package.json:147` | `${PI_IMAGE:-ngodeai/pi:dev}` | `${NGODEAI_IMAGE:-ngodeai/ngodeai:dev}` |
| `Dockerfile.dockerignore:1` | "the **pi-root** `Dockerfile` (ngodeai/**pi**:dev)" | "the NgodeAI `Dockerfile` (ngodeai/**ngodeai**:dev)" |
| `Dockerfile.ngodebot:12` | `bun run pi:image … build ngodeai/pi:dev` | `bun run ngodeai:image … build ngodeai/ngodeai:dev` |

### 3b. Install scripts — shipped to end users (4)

`scripts/install.sh` is served at `https://ngodeai.net/install.sh` (`README.md:66`). A user following the new brand would export `NGODEAI_INSTALL_DIR` and get silently ignored.

| Path:line | Token | Suggested replacement |
| --- | --- | --- |
| `scripts/install.sh:15` | comment `PI_BUILD_URL` | `NGODEAI_BUILD_URL` |
| `scripts/install.sh:20` | `PI_INSTALL_DIR` | `NGODEAI_INSTALL_DIR` (keep `: ${PI_INSTALL_DIR:-}` fallback if compat wanted) |
| `scripts/install.sh:21` | `PI_BUILD_URL` | `NGODEAI_BUILD_URL` |
| `scripts/install.ps1:34` | `$env:PI_INSTALL_DIR` | `$env:NGODEAI_INSTALL_DIR` |
| `scripts/install.ps1:35` | `$env:PI_BUILD_URL` | `$env:NGODEAI_BUILD_URL` |

(`scripts/install.ps1:13` carries the same stale comment `$env:PI_BUILD_URL` — fold into the same fix.)

### 3c. Code — user-visible / genuine bug (4)

| Path:line | Token | Suggested replacement | Why |
| --- | --- | --- | --- |
| `packages/utils/src/dirs.ts:55` | `["NGODEAI_PROFILE", "NGODEAI_PROFILE", "PI_PROFILE"]` | `["NGODEAI_PROFILE", "PI_PROFILE"]` | **Rebrand-mangled.** The first element was rewritten from `PI_PROFILE` to `NGODEAI_PROFILE`, duplicating the canonical name. Proof: `dirs.ts:141` `readPiProfileFromEnvSafe()` still reads `process.env.PI_PROFILE`, and the callers at `:109`/`:114` still pass `NGODEAI_PROFILE, PI_PROFILE`. The array is also dead (no reader — see `grep`), so this is cosmetic-plus-misleading, but it is an unambiguous rebrand defect. |
| `packages/coding-agent/src/cli/help-extra.ts:68` | `PI_CODING_AGENT_DIR` in `ngodeai --help` | `NGODEAI_AGENT_DIR` | Ships in help output; sits two lines under `NGODEAI_PROFILE`, so `--help` shows both prefixes. |
| `packages/coding-agent/src/cli/help-extra.ts:69-73` | `PI_PACKAGE_DIR`, `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`, `PI_NO_PTY` | `NGODEAI_*` equivalents | Same `--help` block; canonical spelling is `NGODEAI_<X>`. |
| `packages/coding-agent/src/commands/launch-help.ts:21-23` | `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL` in flag descriptions | `NGODEAI_SMOL_MODEL` etc. | Printed by `ngodeai --help` for `--smol/--slow/--plan`. |

Note on `crates/ngode-natives/src/crash_handler.rs:291,320` and `oauth_callback/darwin.rs:422`: these Rust readers consult **only** `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`, never `NGODEAI_CONFIG_DIR` / `NGODEAI_AGENT_DIR`. Because `mirrorEnvAliases` runs in the **JS** process, a `NGODEAI_CONFIG_DIR` set *only* in a parent shell still reaches them (JS mirrors it into the env it passes to children), so this is **NOT listed as MUST FIX** — but flagging it: it is the one place where the canonical prefix has no direct read path, and it would break if the native layer is ever entered without the JS bootstrap. Recommend adding the `NGODEAI_*` read first, keeping `PI_*` as fallback (see INTENTIONAL).

### 3d. Docs — `PI_*` documented as the primary user-facing spelling (45)

`docs/environment-variables.md:23` states the canonical rule: "`NGODEAI_CONFIG_DIR` (legacy alias: `PI_CONFIG_DIR`)". Every row below contradicts it by presenting the legacy name as *the* name. Suggested replacement is uniformly the `NGODEAI_` form of the token on that line.

| Path:line | Token | Suggested replacement |
| --- | --- | --- |
| `docs/environment-variables.md:487` | `PI_TIMING` | `NGODEAI_TIMING` |
| `docs/environment-variables.md:488` | `PI_DEBUG_STARTUP` | `NGODEAI_DEBUG_STARTUP` |
| `docs/environment-variables.md:567` | `NGODEAI_PROFILE` "wins over `NGODEAI_PROFILE` and `PI_PROFILE`" | **Rebrand-mangled**: should read "wins over `PI_PROFILE`" (self-reference, the old name was overwritten) |
| `docs/environment-variables.md:568` | `PI_PROFILE` (row heading) | `NGODEAI_PROFILE` (legacy `PI_PROFILE`) |
| `docs/environment-variables.md:569` | "Legacy aliases: `NGODEAI_CONFIG_DIR`, `PI_CONFIG_DIR`" | drop the duplicated `NGODEAI_CONFIG_DIR` |
| `docs/environment-variables.md:570` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/environment-variables.md:571` | `PI_CODING_AGENT_SESSION_DIR` | `NGODEAI_CODING_AGENT_SESSION_DIR` |
| `docs/environment-variables.md:572` | `PI_NATIVES_DIR` | `NGODEAI_NATIVES_DIR` |
| `docs/environment-variables.md:573` | `PI_CONFIG_FILES` | `NGODEAI_CONFIG_FILES` |
| `docs/environment-variables.md:580` | `PI_BUILD_URL` | `NGODEAI_BUILD_URL` |
| `docs/environment-variables.md:581` | `PI_GRAMMARS_URL` | `NGODEAI_GRAMMARS_URL` |
| `docs/environment-variables.md:609-610` | `PI_SESSION_ID`, `PI_SESSION_FILE` | `NGODEAI_SESSION_ID`, `NGODEAI_SESSION_FILE` |
| `docs/settings.md:24` | `PI_PROFILE` as the fallback spelling | `NGODEAI_PROFILE` (mention `PI_PROFILE` as legacy) |
| `docs/settings.md:26` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/settings.md:72` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/settings.md:147` | `PI_CODING_AGENT_DIR` (table row) | `NGODEAI_AGENT_DIR` |
| `docs/settings.md:148` | `PI_PROFILE` | `NGODEAI_PROFILE` |
| `docs/settings.md:1086` | `PI_…` in troubleshooting text | `NGODEAI_…` |
| `docs/config-usage.md:74` | `PI_PROFILE` fallback | `NGODEAI_PROFILE` |
| `docs/config-usage.md:78` | `statusLine.segmentOptions.pi.showProfile` | `statusLine.segmentOptions.ngodeai.showProfile` (matches `packages/tui/src/status-line/segments.ts:240`) |
| `docs/cli-reference.md:93` | `PI_NO_TITLE` | `NGODEAI_NO_TITLE` |
| `docs/models.md:26` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/models.md:27` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/context-files.md:34` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/context-files.md:106` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/hooks.md:85` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/install-id.md:18` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/install-id.md:47` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/lsp-config.md:36` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/mcp-config.md:24` | `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` | `NGODEAI_CONFIG_DIR`, `NGODEAI_AGENT_DIR` |
| `docs/mcp-config.md:50` | `PI_PROFILE` | `NGODEAI_PROFILE` |
| `docs/slash-command-internals.md:84` | `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` | `NGODEAI_CONFIG_DIR`, `NGODEAI_AGENT_DIR` |
| `docs/system-prompt-customization.md:39` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/theme.md:122` | `PI_CODING_AGENT_DIR` (`$PI_CODING_AGENT_DIR/themes`) | `NGODEAI_AGENT_DIR` |
| `docs/rulebook-matching-pipeline.md:81` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/advisor-watchdog.md:283` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/auth-broker-gateway.md:375` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/providers.md:63` | `PI_CONFIG_DIR` | `NGODEAI_CONFIG_DIR` |
| `docs/natives-architecture.md:86` | `PI_DEBUG_STARTUP` | `NGODEAI_DEBUG_STARTUP` |
| `docs/natives-build-release-debugging.md:270` | `PI_NATIVES_DIR` | `NGODEAI_NATIVES_DIR` |
| `docs/natives-build-release-debugging.md:273` | `PI_DEBUG_STARTUP` | `NGODEAI_DEBUG_STARTUP` |
| `docs/natives-addon-loader-runtime.md:20` | `PI_*` family (6 hits) | `NGODEAI_*` |
| `docs/notebook-tool-runtime.md:120-125` | `PI_SESSION_FILE`, `PI_ARTIFACTS_DIR`, `PI_TOOL_BRIDGE_*`, `PI_EVAL_LOCAL_ROOTS` | `NGODEAI_*` equivalents |
| `docs/python-repl.md:143,158,162,247,255-258` | `PI_` allow-prefix, `PI_SESSION_FILE`, `PI_PY`, `PI_JS`, `PI_PYTHON_*` | `NGODEAI_` allow-prefix and `NGODEAI_*` names |
| `docs/bash-tool-runtime.md:103,117,150,160,176,317` | `PI_NO_PTY`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_DISABLE_UUTILS_BUILTINS` | `NGODEAI_*` |
| `docs/extensions.md:1063` | `PI_RPC_EMIT_TITLE` | `NGODEAI_RPC_EMIT_TITLE` |
| `docs/rpc.md:29` | `PI_NO_TITLE`, `PI_NO_PTY` | `NGODEAI_*` |
| `docs/session.md:543` | `PI_TEST_SESSION_OWNERS_DIR` | `NGODEAI_TEST_SESSION_OWNERS_DIR` |
| `docs/task-agent-discovery.md:324` | `PI_BLOCKED_AGENT` | `NGODEAI_BLOCKED_AGENT` |
| `docs/tui-core-renderer.md:102` | `PI_TUI_RESIZE_SCROLLBACK` | `NGODEAI_TUI_RESIZE_SCROLLBACK` |
| `docs/local-models.md:62` | `PI_TINY_DEVICE` (+ family, 8 hits) | `NGODEAI_TINY_DEVICE` |
| `docs/provider-quirks.md:59`, `docs/provider-streaming-internals.md:8`, `docs/provider-compat-reference.md:25`, `docs/provider-endpoint-constraints.md:82` | `PI_*` model/tuning vars | `NGODEAI_*` |
| `docs/skills/examples/hello-extension/README.md:15` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/skills/examples/safety-hook/README.md:21` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/skills/authoring-extensions.md:92` | `PI_CODING_AGENT_DIR` | `NGODEAI_AGENT_DIR` |
| `docs/fs-scan-cache-architecture.md:40`, `docs/ai-schema-normalize.md:37`, `docs/natives-shell-pty-process.md:50`, `docs/natives-text-search-pipeline.md:194`, `docs/porting-to-natives.md:130`, `docs/tui-runtime-internals.md:105` | remaining `PI_*` | `NGODEAI_*` |

> The docs work is really **one mechanical substitution across 40 files / 117 unique vars / 256 lines**, plus 3 hand-fixes where the rebrand mangled a sentence (`environment-variables.md:567,569` and `settings.md:24`). Best executed with a single `sed -E 's/\bPI_([A-Z0-9_]+)/NGODEAI_\1/g'` over `docs/`, then reverting the genuinely-legacy mentions the same pass would touch (see §4).

---

## 4. INTENTIONAL (do not "fix")

| Item | Why intentional |
| --- | --- |
| `packages/utils/src/env.ts:272` `LEGACY_ENV_PREFIXES = ["PI_"]`, `mirrorEnvAliases()` `:282-300` | This *is* the migration mechanism: canonical `NGODEAI_*` → legacy `PI_*` mirror. The comment at `:266` states the design. |
| `packages/utils/src/dirs.ts:345,352,552,557` (`NGODEAI_CONFIG_DIR || PI_CONFIG_DIR`, `NGODEAI_AGENT_DIR || PI_CODING_AGENT_DIR`) | Canonical-first compat fallback for existing installs. |
| `packages/utils/src/dirs.ts:40` `LEGACY_CONFIG_DIR_NAMES = [".omp", ".pi"]` | One-way first-run migration of pre-rebrand config roots; explicitly documented as never used for steady-state resolution. |
| `packages/utils/src/dirs.ts:109,141,718` `process.env.PI_PROFILE` | Compatibility fallback + the `PI_PROFILE` writer used to pin forks; `:141` is the live reader the duplicated `PROFILE_ENV_KEYS` row should reference. |
| `packages/coding-agent/src/extensibility/legacy-pi-*.ts`, `plugins/legacy-pi-compat.ts` (`@ngodeai` alias array, `PI_PACKAGE_RENAMES`, `PI_BUNDLED`) | Legacy plugin/shim layer that must keep resolving `@mariozechner/*`, `@earendil-works/*`, `.pi/` and `PI_BUNDLED` for already-published third-party plugins. |
| `packages/coding-agent/src/extensibility/**/{loader,manager,directory-resolution,installer}.ts` `pkg.ngodeai ?? pkg.pi`, `.pi` dir probes | Canonical-first manifest/override lookup with `.pi` legacy fallback. |
| `packages/coding-agent/src/lsp/config.ts:407-408` `.pi/lsp.*`, `~/.pi/agent/lsp.*` | Third-party (upstream `pi`) config discovery interop, alongside `.claude/`, `.codex/`. |
| `packages/metaharness/src/runner.ts:33,36,1394,1419-1421` `--agent pi` | `pi` is an *upstream agent id* (`@earendil-works/pi-coding-agent`), a peer to `ngodeai` in `MANAGED_AGENTS`, not this product's name. |
| `crates/ngode-natives/src/crash_handler.rs`, `oauth_callback/darwin.rs` `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR` reads | Legacy-alias reads that mirror `packages/utils/src/dirs.ts`. Should *gain* an `NGODEAI_*` read first (see §3c note) but the `PI_*` read itself stays. |
| `sdk/go/ngodeai-rpc/smoke_test.go:24,73`, `sdk/rust/ngodeai-rpc/tests/smoke.rs:85,270` | Test harnesses isolating state via the alias; both prefixes resolve identically. |
| Internal flag readers: `$env.PI_NO_PTY`, `$env.PI_NOTIFICATIONS`, `PI_PROXY*`, `PI_STREAM_*_TIMEOUT_MS`, `PI_AUTO_QA*`, `PI_TINY_DEVICE`, `PI_DOCS_EMBED`, `PI_EVAL_LOCAL_ROOTS`, `crates/gode-shell` `PI_DISABLE_*`, etc. (~500 lines) | They read the legacy alias deliberately; `NGODEAI_<X>` works for all of them after the startup mirror. Not user docs. |
| `packages/coding-agent/src/modes/controllers/command-controller.ts:1514-1516` + `PI_CONFIG_FILES`/`PI_CODING_AGENT_SESSION_DIR` | Fork isolation deliberately pins **both** spellings so a child works under either prefix. Paired with `NGODEAI_PROFILE` at `:1517` by design. |
| `docs/porting-from-pi-mono.md` (13 hits), `packages/coding-agent/DEVELOPMENT.md:158` | The doc *is* about upstream `pi-mono` syncs; renaming it would erase meaning. |
| `docs/user-facing-packages.md:53` `badlogic/pi-mono` | Upstream fixture source the benchmark generator genuinely clones (`typescript-edit-benchmark/src/generate.ts:52`). |
| `packages/typescript-edit-benchmark/src/generate.ts:3,49,52,190,196` | Same: real upstream repo URL + `@pi-mono-source` temp-dir tag. |
| `packages/tui/src/**` (`pi-tui`, `pi-mono`) comments, `packages/ai/src/providers/cursor.ts:2560`, `packages/collab-web/.../eval.tsx:361`, `packages/coding-agent/src/**` (`pi-coding-agent`, `@mariozechner/pi-coding-agent`, `@earendil-works/pi-coding-agent`) | Comments naming the **upstream packages this code was ported from / kept API-compatible with**. Renaming would falsify provenance. |
| `docs/settings.md:24` mention of `statusLine.segmentOptions.pi` (and `segments.ts:240`) | The setting key is `pi` in code; the *value* is the brand glyph. Fix doc text only; **do not** rename the key (config compat). |
| `packages/utils/src/logger.ts:9,280,322` `process.pid` | False positive — `pid`, not the brand. |
| `packages/catalog/src/provider-models/openai-compat.ts:8056,8097` `SINGULARITYAPI_IMAGE_*` | False positive — third-party endpoint constant. |
| `python/ngodebot/**` (~1,050 hits) | Live product name + `NGODEBOT_*` prefix; correctly branded, unrelated to the rename. |

---

## 5. NOISE (test fixtures / generated)

| Item | Why noise |
| --- | --- |
| `packages/coding-agent/test/**` (`legacy-pi-*.test.ts`, `pi-scope-aliases.test.ts`, `custom-tool-loader.test.ts`, `test/fixtures/*.jsonl`) | Tests that *assert* the legacy alias/shim behaviour; unrelated to branding. |
| `scripts/install.test.ts:91,121-122`, `scripts/install-tests/settings-session.ts:185` | Assert the installer/agent-dir env wiring; will need the §3b rename to stay green, but the token itself is fixture wiring. |
| `packages/coding-agent/test/cli/{build-service,update-cli}.test.ts` `PI_BUILD_URL` | Environment save/restore fixtures. |
| `packages/*/dist/**`, `packages/*/dist/types/**` (`legacy-pi-*.d.ts`, `docs-index.generated.txt`) | Build output, gitignored (`packages/*/dist/`), regenerated from `src`. |
| `scripts/release.ts:3` `Release script for pi-mono` | **Borderline — recommend fixing**, but it is an internal docstring, not shipped or copy-pasted. Suggested: `NgodeAI monorepo`. |

---

## 6. Top 10 clusters by file count

| # | Cluster (folder / area) | Files |
| --- | --- | --- |
| 1 | `docs/*.md` (flat handbook) | 40 |
| 2 | `packages/coding-agent/src/**` (core agent) | 41 |
| 3 | `crates/**` (Rust engine) | 16 |
| 4 | `packages/tui/src/**` | 16 |
| 5 | `packages/ai/src/**` | 15 |
| 6 | `packages/utils/src/**` | 9 |
| 7 | `scripts/**` (install + CI helpers) | 7 |
| 8 | `packages/catalog/src/**` | 4 |
| 9 | `packages/coding-agent/scripts/**` | 4 |
| 10 | `sdk/**` (Go + Rust RPC) | 2 |
