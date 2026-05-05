# Val-iQ Trading

Open-source trading infrastructure for running LLM-assisted strategies with deterministic risk enforcement, provider-truth reconciliation, and a typed Convex control plane.

This repository contains the reusable runtime, venue adapters, dashboard, and operational tooling. Live strategies, private plans, and deployment-specific notes live in the ignored `private/` overlay.

## What This Repo Includes

- `apps/backend`: single TypeScript runtime for strategy execution across supported venues
- `apps/mt5-worker`: Python worker exposing MT5 broker operations over HTTP
- `apps/dashboard`: operational dashboard backed by Convex
- `packages/*`: shared execution, risk, provider, agent, and Convex code

## Private Overlay

This repo ignores `private/` by default. That directory is for operator-local files that should not be committed:

- `private/strategies.md`
- `private/plan.md`
- `private/context.md`
- deployment notes, runbooks, or one-off maintenance scripts tied to your own accounts

The strategy CLI reads `private/strategies.md`.

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

### MT5 Worker Private Files

Any machine that runs `apps/mt5-worker` must keep the broker server database at `private/mt5-worker/servers.dat`.

- The worker copies that file into each portable MT5 instance before `MetaTrader5.initialize(...)`
- The file is required and intentionally not committed
- If you intentionally keep it outside the repo's private overlay, set `MT5_SERVERS_DAT_PATH` explicitly

If the file is missing, the worker fails closed with a clear error instead of starting against a stale or implicit fallback path.

On Windows deployments, set `WORKER_EXPECTED_REPO_SUFFIX` if you want the worker to fail closed unless it is running from an expected repo path.

### Polymarket Funder Address

`POLYMARKET_FUNDER_ADDRESS` is required and must be set explicitly. The runtime does not derive it from the private key and does not fall back to any other wallet address.

Operator workflow:

1. Run `bun run packages/polymarket/src/derive-api-key.ts <private-key>` to derive the L2 API credentials from the signer key you exported for Polymarket. By default this writes them to `private/polymarket-credentials.env` with restrictive file permissions. Use `--stdout` only when you explicitly want terminal output.
2. Copy `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, and `POLYMARKET_PRIVATE_KEY` from that file into Convex env vars.
3. In Polymarket, copy the profile or proxy wallet address shown in the account UI and set that exact value as `POLYMARKET_FUNDER_ADDRESS`.
4. Open Dashboard > Test > Polymarket and verify the `Runtime Config` step shows the expected signer and funder addresses, then verify `Authenticated Runtime Path` is green before enabling scheduled runs.

## Development

```bash
bun run dev
```

## Strategy Management

Keep your strategy document in `private/strategies.md`.

| Command | Description |
|---|---|
| `bun run strategies:diff` | Compare the strategy document against backend state |
| `bun run strategies:list` | List all strategies in backend with IDs |
| `bun run strategies:add --name="..."` | Add one strategy from the strategy document |
| `bun run strategies:add-all` | Add all strategies from the strategy document without deleting existing |
| `bun run strategies:delete --name="..."` | Delete one strategy by name and cascade related data |
| `bun run strategies:delete --id=<id>` | Delete one strategy by Convex ID |
| `bun run strategies:reset` | Delete all strategies and associated data |
| `bun run strategies:reset-import` | Delete everything and re-import the strategy document |

Examples:

```bash
bun run strategies:diff
bun run strategies:add --name="Example Strategy"
bun run strategies:reset-import
```

## Architecture

The backend runs N strategies, each defined by a config record in Convex:

- `policy`: typed and schema-validated deterministic settings enforced by code
- `context`: freeform prompt context injected into the agent system prompt

The agent proposes intents. The risk layer validates them. The venue adapter executes them. The system records execution and reconciliation state in Convex.

## Auth Model

- Dashboard users should use Convex Auth only
- Backend machine traffic uses `BACKEND_SERVICE_TOKEN` only for machine-only Convex actions such as secret resolution
- MT5 worker traffic uses `MT5_WORKER_ACCESS_KEY` on every backend-to-worker request, including health checks

Rotate machine secrets by generating a new value, updating the target service first, then updating the caller, and redeploying both ends so there is no mismatch window.

## Stack

- Bun
- TypeScript
- Turborepo
- Convex
- Val-iQ
- Python for the MT5 worker only

## Open Source

This repository is intended to publish the reusable platform code. Operator-specific strategies, plans, secrets, and deployment details should remain outside version control in `private/`.
