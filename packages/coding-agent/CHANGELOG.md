# Changelog

All notable changes to NgodeAI CLI will be documented in this file.

## [1.0.7] - 2026-10-28

### Changed

- **Compact 1-line Subagent HUD**: replaced the multi-line tree list of running subagents above the input prompt with a clean, single-line status indicator (`Sub Agents · <N> running [Alt+A to open]`) that dynamically reports active subagent count.
- **Animated shimmer on Subagent HUD**: added a metallic glint/shimmer sweep animation across the HUD line while subagents are running.

## [1.0.6] - 2026-10-28

### Fixed

- **Sidebar dynamic model synchronization**: the sidebar now listens directly to `model_changed` events and refreshes immediately when the live model changes (via background discovery, `/model`, or setup wizard), rather than waiting on unrelated UI actions.
- **Decision model synchronization**: when no dedicated native System One decision model is reachable on the gateway, the decision model row synchronizes directly with the active live model displayed under the input prompt.
- **Sandbox review isolation**: `scripts/review.ts` now prevents host shell API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) from inadvertently leaking into the test review sandbox.

## [1.0.5] - 2026-10-28

### Fixed

- A fresh session opened with the previous launch's model in the sidebar while the status line under the prompt already showed the resolved default. `init()` finished without calling `#syncSidebar()`, so the pane kept the snapshot the last session wrote until some unrelated event refreshed it. It now paints from live session state before the composer is handed back.
- The `DECISION MODEL` row no longer presents an ordinary chat model as a decision model. The judge role chain ends in `@default`, so an account with no reachable System One model resolves to a chat row that answers with one-hot confidence; the pane now carries `native` from `kindOf` and prints `no native judge`.

## [1.0.4] - 2026-10-28

### Fixed

- The sidebar, `/decisions` autocomplete, and the status line now report the decision model that **actually answered**, not the first entry of the judge role chain. `primaryModel()` is an observed fact once a judgment runs, and the planned candidate is labelled `pending` until then.
- The gateway's `ngodeai/` id prefix is no longer stored in the catalog id, which had produced `ngodeai/ngodeai/jev-1.14` in the transcript, the sidebar, and every judgment log line. The wire form is preserved in `requestModelId`.
- One helper (`stripModelProviderPrefix`) replaces five separate `startsWith("ngodeai/")` / `slice(8)` copies, so no surface can drift from another.
- `ngodeai` is discovery-only again: the committed snapshot no longer resurrects bare-and-prefixed duplicate rows, which let one selector match two rows with different `kind` values.
- Removed the bundled `gemini-3.8-flash` / `mercury-decide` seed rows, which duplicated what discovery returns and made a failed fetch look like a working one.
- The sidebar's startup snapshot no longer replays the previous session's MODEL row. It is written with the model the _next_ launch will start with — the same one the status line uses — so a fresh session can no longer open with an old model in the pane and a different one under the prompt.
- A judge that resolves to an ordinary chat model (the `@default` tail of the role chain) is labelled `prompted · <api>` instead of `native System One`. `kindOf` decides, so a chat fallback is never presented as System One.
- The composer startup cache now preserves `confirmed` on the decision-model row, so a session that had answered decisions no longer reopens as `pending`.

## [1.0.3] - 2026-10-27

### Fixed

- Decision cards and the `find` tool header now name the decision model that actually answered (`jev-1.14`, `mercury-decide`, …) instead of rewriting every `jev-*` result to `mercury-decide`. The transcript now agrees with `/decisions` and the ledger, and the billed route is visible again.
- Decision card falls back to `unknown` rather than inventing a model name when the event carries none.
- Reformatted `packages/ai/src/judgment/systemone.ts` so `oxfmt --check` passes in CI.

## [1.0.2] - 2026-10-27

### Added

- Integrated Jev Engineering System One decision intelligence with calibrated probability bars and risk-tiered gate matrices.
- Dedicated `DECISION MODEL` section in the live right-hand status sidebar.
- Real-time decision model status reflection in `/decisions` slash command autocomplete.
- Comprehensive system architecture Mermaid diagrams and Jev Engineering documentation.

### Fixed

- Fixed decision cards and find tool output borders extending past the transcript pane into the right sidebar.
- Fixed fresh session startup defaulting to Claude Opus instead of NgodeAI / Gemini 3.8 Flash.
- Fixed `padToPane` in composer to strictly enforce transcript boundaries and protect the sidebar divider.
- Bundled `gemini-3.8-flash` and `mercury-decide` in static models catalog for instant cold-start availability.

## [1.0.0] - 2026-10-25

### Added

- Initial production release of NgodeAI CLI.
- High-performance autonomous coding agent with native Rust core acceleration (~80k lines).
- Flicker-free Differential Terminal UI (TUI) with streaming syntax-highlighted diffs.
- Full tool autonomy: `read`, `edit`, `write`, `bash`, `grep`, `glob`, `task`, `eval`, `todo`.
- Multi-provider support for 60+ AI providers (Anthropic Claude, OpenAI, Google Gemini, DeepSeek, Ollama local models, and more).
- Native Language Server Protocol (LSP) and Debug Adapter Protocol (DAP) integration.
- Parallel worker subagents (`scout`, `reviewer`, `task`) for context-preserving code inspection.
- Full backwards compatibility with legacy configuration paths and environment variables.
