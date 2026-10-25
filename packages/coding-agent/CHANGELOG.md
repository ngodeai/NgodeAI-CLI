# Changelog

All notable changes to NgodeAI CLI will be documented in this file.

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
