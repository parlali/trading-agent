Always use bun to run commands.
Always use typescript over javascript.
Always use 4 spaces to indent code.
Never use semicolons when its optional for the language.
Never write inline comments in code.
No Emojis anywhere.

This is financial trading software. Correctness, auditability, deterministic accounting, and provider-truth reconciliation matter more than convenience.

Never duplicate logic.
Never create multiple sources of truth.
Always clean up redundant code.
Use shared abstractions only when they remove real duplication without hiding provider-specific execution semantics.
Do not chain silent fallbacks. Fallbacks must be explicit, logged, bounded, and fail closed for execution, ownership, accounting, credentials, and provider identity.
Keep tool schemas, adapter contracts, persisted state, and provider payload mapping typed and canonical.
Treat ownership, reconciliation, dry-run accounting, and order lifecycle bugs as safety-critical defects.
When fixing runtime bugs, trace the full path: agent tool schema -> handler -> execution pipeline -> venue adapter -> provider API -> Convex persistence -> dashboard/read model.
Tests must cover the real failure mode from logs or exports whenever possible; connection tests must exercise the same runtime config, credentials, and provider path as scheduled strategies.
Do not mark safety or accounting plan items complete until a replay, export audit, or provider-sync check proves the intended behavior.
Plan items describe intended behavior to achieve, not specific changes to follow blindly. Implement the smallest correct design that satisfies the behavior and note deviations in your local private plan file when you use one.

When working on local private plan tasks:
- ALWAYS check off completed tasks: `- [ ]` becomes `- [x]`
- Add brief notes in parentheses when implementation differs from the original wording
- The plan is the source of truth for progress tracking
- Do not skip or gloss over plan items. Fully implement each intended behavior, then double-check direct and downstream effects for cleanliness, duplication, and bugs.
