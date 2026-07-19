# Contributing

Thanks for contributing.

## Scope

This repository is the open-source core of the trading runtime. Keep contributions focused on reusable platform code, documentation, and tests. Do not commit private strategies, credentials, account identifiers, or deployment-specific operator notes.

## Development Rules

- Use Bun for commands
- Use TypeScript over JavaScript
- Use 4 spaces for indentation
- Omit semicolons where the language allows
- Prefer typed, canonical schemas and provider mappings
- Keep execution, accounting, and reconciliation flows deterministic

## Local Setup

```bash
bun install
```

Run tests or targeted checks relevant to your change before opening a pull request.

## Private Overlay

If you need local strategy docs or private runbooks, keep them in `private/`. The public repository should not contain live strategy files or private operator documents.

## Pull Requests

- Keep changes scoped and reviewable
- Include tests when behavior changes
- Call out execution, accounting, or reconciliation risk explicitly when relevant
- Update public docs when workflows or defaults change
