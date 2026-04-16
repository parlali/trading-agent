# Val-iQ Trading

Private trading monorepo. LLM agents execute strategies across multiple venues with deterministic risk policy enforcement.

## Apps

| App | Description | Venue |
|---|---|---|
| `apps/backend` | Single TypeScript runtime for all venue strategies | Alpaca, Polymarket, MT5, OKX perpetual swaps |
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
| `packages/okx` | OKX perpetual swap client, adapter, and risk rules |

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
- `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, and `POLYMARKET_FUNDER_ADDRESS` in Convex env vars for Polymarket
- `OKX_API_KEY`, `OKX_API_SECRET`, and `OKX_API_PASSPHRASE` in Convex env vars for OKX
- `OKX_DEMO_TRADING` in Convex env vars and set explicitly to `true` or `false`
- `OKX_MARGIN_MODE` in Convex env vars and set explicitly to `cross` or `isolated`
- `OKX_POSITION_MODE` in Convex env vars and set explicitly to `net_mode` or `long_short_mode`
- `OKX_BASE_URL` in Convex env vars only when you need to override the default official host (`https://www.okx.com`)

Set `OKX_DEMO_TRADING=true` to use OKX demo trading for live-order-path testing without real capital. The runtime sends OKX's `x-simulated-trading: 1` header on authenticated requests in that mode.

Generate machine credentials with a high-entropy random value, for example:

```bash
openssl rand -hex 32
```

Use one generated value for `BACKEND_SERVICE_TOKEN` and a different one for `MT5_WORKER_ACCESS_KEY`.

After auth is deployed, create the single dashboard user from the Convex dashboard Functions page by running the internal action `seedUserAction:seedUser` with:

```json
{
    "email": "you@example.com",
    "password": "your-plain-text-password"
}
```

The password should be entered in plain text there. It is hashed automatically by the action before anything is stored.

### Polymarket Funder Address

`POLYMARKET_FUNDER_ADDRESS` is required and must be set explicitly. The runtime does not derive it from the private key and does not fall back to any other wallet address.

Operator workflow:

1. Run `bun run packages/polymarket/src/derive-api-key.ts <private-key>` to derive the L2 API credentials from the signer key you exported for Polymarket.
2. Copy `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, and `POLYMARKET_PRIVATE_KEY` into Convex env vars.
3. In Polymarket, copy the profile or proxy wallet address shown in the account UI and set that exact value as `POLYMARKET_FUNDER_ADDRESS`.
4. Open Dashboard > Test > Polymarket and verify the `Runtime Config` step shows the expected signer and funder addresses, then verify `Authenticated Runtime Path` is green before enabling scheduled runs.

If the signer address is correct but order placement later fails, re-check `POLYMARKET_FUNDER_ADDRESS` first. The runtime signs requests with `POLYMARKET_PRIVATE_KEY`, but Polymarket orders are created with `POLYMARKET_FUNDER_ADDRESS` as the maker or owner.

### Development

```bash
bun run dev
```

## Strategy Management

`strategies.md` is the source of truth. Edit it, then push to Convex with the commands below.

| Command | Description |
|---|---|
| `bun run strategies:diff` | Compare strategies.md against backend |
| `bun run strategies:list` | List all strategies in backend with IDs |
| `bun run strategies:add --name="..."` | Add one strategy from strategies.md |
| `bun run strategies:add-all` | Add all from strategies.md without deleting existing |
| `bun run strategies:delete --name="..."` | Delete one strategy by name (cascades all data) |
| `bun run strategies:delete --id=<id>` | Delete one strategy by Convex ID |
| `bun run strategies:reset` | Delete all strategies and associated data |
| `bun run strategies:reset-import` | Delete everything then import all from strategies.md |

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
