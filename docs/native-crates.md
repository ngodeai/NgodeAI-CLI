# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@ngodeai/natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. Its `[patch.crates-io]` selects vendored `brush-core`, `brush-parser`, `cfg_aliases`, `napi`, and `tree-sitter-go`.

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ngode-natives`    | [`crates/ngode-natives`](../crates/ngode-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `ngode-ast`, `ngode-diff`, `ngode-edit`, `ngode-iso`, `ngode-predict`, `ngode-shell`, `ngode-vcs`, `ngode-vfs`, `ngode-voice`, and `ngode-walker`.                    |
| `ngode-builtins`   | [`crates/ngode-builtins`](../crates/ngode-builtins)     | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that the utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `ngode-diff` | [`crates/ngode-diff`](../crates/ngode-diff) | N-API-free jsdiff-compatible Myers, line, word, and structured-patch primitives, consumed by native diff bindings and the edit engine. |
| `ngode-edit` | [`crates/ngode-edit`](../crates/ngode-edit) | Edit-mode parsing, matching, staging, streaming previews, snapshots, and host-writer application; wrapped by native `EditSession` / `EditStore`. |
| `ngode-predict` | [`crates/ngode-predict`](../crates/ngode-predict) | N-API-free ngram, SmolLM, and macOS spelling-backed word-completion engines, wrapped by `TextPredictor`. |
| `ngode-vfs` | [`crates/ngode-vfs`](../crates/ngode-vfs) | Injectable async filesystem plus a blocking facade, native host fast paths, and URL-preserving lexical helpers shared by shell, builtins, and traversal. |
| `ngode-shell`      | [`crates/ngode-shell`](../crates/ngode-shell)           | Persistent embedded brush shell, command execution/minimization, process plumbing, and in-process command integration used by `ngode-natives`; traversal and injectable filesystem primitives live in `ngode-walker` and `ngode-vfs`. |
| `ngode-voice`      | [`crates/ngode-voice`](../crates/ngode-voice)           | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                          |
| `ngode-ast`        | [`crates/ngode-ast`](../crates/ngode-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization. Common grammars are linked in; the rest load as WebAssembly modules the agent downloads on first use (`src/language/grammar.rs`). They are built and published by [stencil-hq/wasm-grammars](https://github.com/stencil-hq/wasm-grammars); `bun run gen:grammars` pins the latest release in `src/language/wasm_grammars.rs`. |
| `ngode-iso`        | [`crates/ngode-iso`](../crates/ngode-iso)               | Isolation backend implementations and diffing for APFS, btrfs, ZFS, Linux reflinks, overlayfs, Windows block clones, and ProjFS; fallback uses a Git worktree for Git repositories and recursive copy otherwise.                      |
| `ngode-walker`     | [`crates/ngode-walker`](../crates/ngode-walker)         | Parallel filesystem walker using ignore rules and globsets, shared by native scans and shell commands. Reads go through `ngode-vfs`; bulk syscalls require native-local paths and the shared cache requires no provider.                         |
| `ngode-vcs`        | [`crates/ngode-vcs`](../crates/ngode-vcs)               | In-process version control: git on gitoxide (the git binary also handles credential-bound network transfers, reftable repos, and whole-worktree status/untracked walks) and Jujutsu on jj-lib; unified discovery and operations used by the `vcs*` native bindings. |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core), [`crates/vendor/brush-parser`](../crates/vendor/brush-parser) | Vendored shell engine and its tokenizer/parser, consumed by `ngode-shell` and `ngode-builtins`. Their manifests retain upstream package metadata; workspace patches select these local forks. |
| Build/runtime compatibility | [`crates/vendor/cfg_aliases`](../crates/vendor/cfg_aliases), [`crates/vendor/napi`](../crates/vendor/napi), [`crates/vendor/tree-sitter-go`](../crates/vendor/tree-sitter-go) | Workspace patches fix macro compatibility, N-API environment teardown, and Go grammar support respectively. |

`ngode_builtins::default_builtins()`, `ngode_builtins::utility_builtins()`, and `ngode_builtins::process_builtins()` (defined in `src/factory.rs`) are the authoritative builtin sets; `ngode-shell` decides which of them to register. A directory being a workspace member does not by itself mean that `ngode-natives` exposes it as a JavaScript API.

## Boundary map

```text
@ngodeai/natives JS entrypoints
  -> ngode-natives (N-API conversion, platform bindings, task boundaries)
       -> ngode-ast / ngode-diff / ngode-edit / ngode-iso / ngode-predict / ngode-vcs / ngode-voice
       -> ngode-walker / ngode-vfs
       -> ngode-shell
            -> brush-core (parser, expansion, interpreter)
            -> ngode-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
            -> ngode-vfs / ngode-walker (filesystem provider and traversal)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@ngodeai/natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
