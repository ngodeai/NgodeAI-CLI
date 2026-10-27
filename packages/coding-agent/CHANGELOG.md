# Changelog

All notable changes to NgodeAI CLI will be documented in this file.

## [1.0.2] - 2026-10-27

### Added

- Integrated Jev Engineering System One decision intelligence with calibrated probability bars and risk-tiered gate matrices.
- Dedicated `DECISION MODEL` section in the live right-hand status sidebar.
- Real-time decision model status reflection in `/decisions` slash command autocomplete.
- Comprehensive system architecture Mermaid diagrams and Jev Engineering documentation.

### Fixed

- Fixed decision cards and find tool output borders extending past the transcript pane into the right sidebar.
- Fixed decision card header displaying raw internal wire model `jev-1.14` instead of catalog identity `mercury-decide`.
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
