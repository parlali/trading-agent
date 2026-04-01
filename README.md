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

Configure these secrets before starting the backend:

- `CONVEX_URL` in the backend runtime
- `BACKEND_SERVICE_TOKEN` in both Convex env vars and the backend runtime
- `MT5_WORKER_ACCESS_KEY` in both Convex env vars and the MT5 worker runtime

Generate machine credentials with a high-entropy random value, for example:

```bash
openssl rand -hex 32
```

Use one generated value for `BACKEND_SERVICE_TOKEN` and a different one for `MT5_WORKER_ACCESS_KEY`.

After auth is deployed, create the single dashboard user from the Convex dashboard Functions page by running the internal action `seedUserAction:seedUser` with:

```json
{
    "email": "you@example.com",
    "password": "your-plain-text-password",
    "serviceToken": "your-backend-service-token"
}
```

The password should be entered in plain text there. It is hashed automatically by the action before anything is stored.

### Development

```bash
bun run dev
```

## Architecture

The backend runs N strategies, each defined by a config record in Convex:
- **policy** -- typed, schema-validated. Deterministic risk limits enforced by code.
- **context** -- freeform string injected into the agent system prompt.

The agent proposes intents. The risk layer validates. The venue adapter executes. Everything is logged to Convex.

## Auth Model

- Dashboard users should use Convex Auth only
- Backend machine traffic uses `BACKEND_SERVICE_TOKEN` only for machine-only Convex actions such as secret resolution
- MT5 worker traffic uses `MT5_WORKER_ACCESS_KEY` on every backend-to-worker request, including health checks

Rotate machine secrets by generating a new value, updating the target service first, then updating the caller, and redeploying both ends so there is no mismatch window.

See `plan.md` for the full implementation plan.

## Stack

- Bun + TypeScript
- Turborepo (monorepo orchestration)
- Convex (state layer, real-time DB)
- Val-iQ (market research and data)
- Python (MT5 worker only)
