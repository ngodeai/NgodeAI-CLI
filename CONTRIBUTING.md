# Contributing to NgodeAI CLI

Thank you for your interest in contributing to NgodeAI! Pull requests and community contributions are welcome.

## Before You Start

### Small Changes
Bug fixes, documentation improvements, type annotations, and narrowly scoped test additions can go directly to a pull request.

### Major Changes
For large features, architectural redesigns, or new subsystems, please open a [GitHub Discussion](https://github.com/ngodeai/NgodeAI-CLI/discussions) or issue to outline your proposal before spending time writing the implementation. This ensures alignment with the project roadmap.

## Pull Request Guidelines

1. **Clear Context**: Every pull request should clearly state what was changed, why, and how it was verified.
2. **Verification**: 
   - Run workspace type checks: `bun check:types`
   - Run tests for modified packages: `bun test <path/to/test>`
   - For UI/TUI changes, launch the CLI (`bun packages/coding-agent/src/cli.ts`) and exercise the altered workflow.
3. **Focused Scope**: Keep pull requests focused on one logical change. Avoid mixing unrelated formatting changes or drive-by refactorings.

## AI-Assisted Contributions

AI coding assistants (including NgodeAI itself!) are welcome tools for crafting contributions. However:
- Contributors must review all generated code, understand the diff, and verify the resulting behavior before submitting.
- Automated bulk PRs without human review will be closed.

## Contribution Licensing

All contributions submitted for inclusion in NgodeAI CLI are licensed under the [MIT License](./LICENSE). You must have the legal right to submit the contribution and must preserve applicable third-party copyright notices.
