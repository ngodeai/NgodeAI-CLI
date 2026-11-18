# Changelog

All notable changes to `@ngodeai/ai` will be documented in this file.

## [1.0.9] - 2026-11-18

### Fixed

- GitLab Duo Workflow MCP tool calls are dispatched by their bare tool name: any `mcp__<server>__<tool>` prefix the workflow chooses is stripped before matching, instead of only the one prefix this client used to emit.

## [1.0.0] - 2026-10-25

### Added
- Initial production release under NgodeAI.
