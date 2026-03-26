# Val-iQ Trading

Private trading monorepo. LLM agents execute strategies across multiple venues with deterministic risk policy enforcement.

## Apps

| App | Description | Venue |
|---|---|---|
| `apps/backend` | Single TypeScript runtime for all venue strategies | Alpaca, Polymarket, MT5 |
| `apps/mt5-worker` | Lightweight Python worker that exposes MT5 broker operations over HTTP | MetaTrader 5 |

## Packages

| Package | Description |
|---|---|
| `packages/convex` | Convex backend -- schema, queries, mutations |
| `packages/core` | Shared types, risk engine, execution pipeline, utilities |
| `packages/agent` | Agent runtime, tool registry, LLM client |
| `packages/valiq` | Val-iQ API client (data endpoints + research chat API) |
| `packages/alpaca-options` | Alpaca venue client, adapter, and risk rules |
| `packages/polymarket` | Polymarket venue client, adapter, and risk rules |
| `packages/mt5` | MT5 venue client, adapter, and risk rules |

## Setup

```bash
bun install
```

### Convex

```bash
cd packages/convex
bunx convex dev
```

### Development

```bash
bun run dev
```

## Architecture

The backend runs N strategies, each defined by a config record in Convex:
- **policy** -- typed, schema-validated. Deterministic risk limits enforced by code.
- **context** -- freeform string injected into the agent system prompt.

The agent proposes intents. The risk layer validates. The venue adapter executes. Everything is logged to Convex.

See `plan.md` for the full implementation plan.

## Stack

- Bun + TypeScript
- Turborepo (monorepo orchestration)
- Convex (state layer, real-time DB)
- Val-iQ (market research and data)
- Python (MT5 worker only)
