# Changelog

All notable changes to `@ngodeai/tui` will be documented in this file.

## [1.0.9] - 2026-11-18

### Added

- `StatusSidebar.setSource()` and `Composer.setSidebarSource()` let the host re-read fast-moving sections at frame time; returned sections merge over the pushed snapshot, so a pane can track live token counts without a new `setState()`.
- `StatusLine.getContextMeter()` exposes the exact used tokens, window, and percent the footer renders (including the collab-guest override), so other surfaces mirror the meter instead of recomputing it.

### Changed

- The footer's context segment is built from `getContextMeter()`, keeping one cache and one rounding rule behind both the status line and any surface that mirrors it.

## [1.0.0] - 2026-10-25

### Added
- Initial production release under NgodeAI.
