# Trading Runtime

Open-source trading infrastructure for running LLM-assisted strategies with deterministic risk enforcement, provider-truth reconciliation, and a typed Convex control plane.

The repository contains the reusable runtime, venue adapters, dashboard, agent tooling, and operational scripts. Live strategies, private rollout plans, broker files, credentials, and deployment notes belong in the ignored `private/` overlay.

## What Is Included

- `apps/backend`: TypeScript scheduler, strategy orchestration, provider sync, agent runtime, and backend health server
- `apps/dashboard`: Next.js operator dashboard backed by Convex
- `apps/mt5-worker`: Python FastAPI worker exposing MetaTrader 5 operations over authenticated HTTP
- `packages/core`: shared types, strategy config parsing, risk gates, accounting helpers, and runtime utilities
- `packages/agent`: tool contracts, MCP integration, transcript handling, and model provider adapters
- `packages/convex`: schema, queries, mutations, generated API bindings, and backend client helpers
- `packages/alpaca-options`, `packages/mt5`, `packages/okx`, `packages/polymarket`: venue-specific clients, adapters, risk rules, and payload mapping

## Safety Model

Agents propose intents. Deterministic code owns execution permission, risk validation, account ownership, order lifecycle, accounting, kill switches, provider identity checks, persistence, and reconciliation.

Provider truth remains authoritative for live account state, positions, orders, fills, and reconciliation evidence. Fallbacks must be explicit, logged, bounded, and fail closed for execution, ownership, accounting, credentials, and provider identity.

## Private Overlay

This repo ignores `private/` by default. Use it for operator-local files:

- `private/strategies.md`: account pool and strategy source of truth
- `private/plan.md`: local rollout and audit plan
- `private/context.md`: private operational context
- `private/mt5-worker/servers.dat`: broker server database required by MT5 worker machines
- deployment notes, runbooks, and one-off maintenance scripts tied to your own accounts

Do not commit credentials, broker files, deployment secrets, private strategy prompts, or audit exports.

## Setup

Install dependencies with Bun:

```bash
bun install
```

Start Convex locally when developing Convex functions:

```bash
cd packages/convex
bunx convex dev
```

Start the backend and dashboard in development:

```bash
bun run dev
```

Run the main checks:

```bash
bun run build
bun run test
```

## Runtime Configuration

Backend runtime env:

- `CONVEX_URL`
- `BACKEND_SERVICE_TOKEN`
- `HEALTH_PORT`
- `OPENROUTER_API_KEY` for local fallback when it is not resolved from Convex
- `MCP_PROVIDER_CONFIGS`, or `MCP_SERVER_URL` / `MCP_SERVER_TOKEN` / `MCP_SERVER_ALLOWED_TOOLS`

Dashboard runtime env:

- `NEXT_PUBLIC_CONVEX_URL`
- `BACKEND_URL`
- `BACKEND_SERVICE_TOKEN`

Convex env must also include `BACKEND_SERVICE_TOKEN`. Generate machine credentials with high-entropy random values:

```bash
openssl rand -hex 32
```

Use distinct values for backend machine auth and MT5 worker auth.

After auth is deployed, create the initial dashboard user from the Convex dashboard Functions page by running `seedUserAction:seedUser`:

```json
{
    "email": "you@example.com",
    "password": "your-plain-text-password"
}
```

## Account-Scoped Provider Secrets

Accounts are declared in `private/strategies.md` with a `credentialEnvPrefix`. Provider secrets are resolved from Convex env vars by combining that prefix with each canonical provider key suffix.

For example, an account with `credentialEnvPrefix` set to `OKX_GPT55_LOW` resolves `OKX_API_KEY` from `OKX_GPT55_LOW_API_KEY`.

Canonical provider keys:

| App | Keys |
|---|---|
| `mt5` | `MT5_PRIMARY_LOGIN`, `MT5_PRIMARY_PASSWORD`, `MT5_PRIMARY_SERVER` |
| `alpaca-options` | `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_ENVIRONMENT`, `ALPACA_ACCOUNT_ID` |
| `okx-swap` | `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`, `OKX_BASE_URL`, `OKX_DEMO_TRADING`, `OKX_MARGIN_MODE`, `OKX_POSITION_MODE` |
| `polymarket` | `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, `POLYMARKET_HOST`, `POLYMARKET_CHAIN_ID`, `POLYMARKET_FUNDER_ADDRESS` |

MT5 also needs global worker secrets:

- `MT5_WORKER_URL`
- `MT5_WORKER_ACCESS_KEY`

`OKX_DEMO_TRADING` must be set explicitly to `true` or `false`. `OKX_MARGIN_MODE` must be `cross` or `isolated`. `OKX_POSITION_MODE` must be `net_mode` or `long_short_mode`.

## MT5 Worker

Any machine that runs `apps/mt5-worker` must keep the broker server database at `private/mt5-worker/servers.dat`.

- The worker copies that file into each portable MT5 instance before `MetaTrader5.initialize(...)`
- The file is required and intentionally not committed
- If you intentionally keep it outside the repo private overlay, set `MT5_SERVERS_DAT_PATH`

If the file is missing, the worker fails closed with a clear error instead of starting against a stale or implicit fallback path.

Use a worker-specific `MT5_PORTABLE_DIR` on machines that run other MT5 automation. On Windows deployments, set `WORKER_EXPECTED_REPO_SUFFIX` if the worker should fail closed unless it is running from an expected repo path.

## Polymarket Credentials

`POLYMARKET_FUNDER_ADDRESS` is required and must be set explicitly. The runtime does not derive it from the private key and does not fall back to another wallet address.

Operator workflow:

1. Run `bun run packages/polymarket/src/derive-api-key.ts <private-key>` to derive L2 API credentials from the signer key exported for Polymarket. By default, this writes `private/polymarket-credentials.env` with restrictive file permissions.
2. Copy `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, and `POLYMARKET_PRIVATE_KEY` into the account-scoped Convex env vars.
3. In Polymarket, copy the profile or proxy wallet address shown in the account UI and set that exact value as the account-scoped `POLYMARKET_FUNDER_ADDRESS`.
4. Open Dashboard > Test > Polymarket and verify both the runtime config and authenticated runtime path before enabling scheduled runs.

## Strategy Management

Keep the strategy document in `private/strategies.md`. It contains both the account pool and strategies.

| Command | Description |
|---|---|
| `bun run strategies:diff` | Compare the strategy document against backend state |
| `bun run strategies:list` | List all strategies in backend with IDs |
| `bun run strategies:add --name="..."` | Add one strategy from the strategy document |
| `bun run strategies:add-all` | Add all strategies from the strategy document without deleting existing history |
| `bun run strategies:delete --name="..."` | Delete one strategy by name and cascade related data |
| `bun run strategies:delete --id=<id>` | Delete one strategy by Convex ID |
| `bun run strategies:reset` | Delete all strategies and associated data |
| `bun run strategies:reset-import` | Delete everything and re-import the strategy document |
| `bun run provider:identity-preflight` | Refresh and inspect provider identity, freshness, exposure, and active orders |

Examples:

```bash
bun run strategies:diff
bun run strategies:add --name="Example Strategy"
bun run provider:identity-preflight -- --app=mt5
```

Force resets are safety-critical. Confirm zero open provider exposure, refresh provider truth through the same scheduled credential path, then run the reset/import command only when the provider-sync evidence is clean.

## Agent Chat

Dashboard `/chat` is a global owner chat with the trading agent. It does not require a configured strategy, does not accept `strategyId`, and does not call scheduled strategy execution. The dashboard API route authenticates the Convex dashboard user first, then proxies the bounded chat request to backend `/agent-chat` with `BACKEND_SERVICE_TOKEN`.

The browser sends only the user message, selected `modelProvider` and `modelId`, plus optional chat/session metadata. It must not send raw UI message history or tool outputs as trusted execution state.

Backend `/agent-chat`:

- resolves the selected provider server-side: OpenRouter uses `OPENROUTER_API_KEY` from Convex-resolved secrets or local backend env, and Codex uses the existing dashboard-managed ChatGPT login with the app-server provider
- reports provider availability to the dashboard so Codex can render a bounded model dropdown and OpenRouter can render a free-text model id input
- surfaces OpenRouter model-not-found failures as explicit model selection errors
- persists a trusted server-side transcript for user prompts, assistant responses, tool inputs, tool results, tool errors, and cancelled turns
- reloads follow-up prompts from completed server transcript records
- streams AI SDK UI message parts directly to the dashboard
- aborts provider streaming and tool execution when generation is stopped

Chat tools are separate from scheduled strategy runtime. The current chat registry exposes read-only operational, account, portfolio, run, alert, provider-health, and explicitly configured MCP tools. Execution-capable manual trading tools are intentionally not exposed until a chat-specific typed execution path preserves adapter identity, Convex persistence, deterministic accounting, safety fault recording, and provider-truth reconciliation.

MCP exposure fails closed. Each MCP provider must explicitly allow upstream read-only tool names through `allowedTools` in `MCP_PROVIDER_CONFIGS`, or through comma-separated `MCP_SERVER_ALLOWED_TOOLS` for the single `MCP_SERVER_URL` provider. Tools annotated by the provider as destructive or open-world are blocked even when named in the allowlist. A failing MCP provider is marked unavailable in chat inventory while local read tools remain available.

## Codex Strategy Provider

Codex strategies use the Codex app-server provider. OpenRouter strategies require `OPENROUTER_API_KEY`; Codex ChatGPT strategies require an active dashboard-managed ChatGPT login. Missing credentials fail closed before a scheduled strategy run starts.

Codex strategies must use canonical policy shape:

```json
{
    "dryRun": true,
    "llm": {
        "provider": "codex",
        "model": "your-codex-model",
        "authMode": "chatgpt"
    }
}
```

Scheduled Codex strategies must use `authMode = "chatgpt"`. Open Dashboard > Integrations > Codex ChatGPT Login and start the device-code login flow. The backend runs `codex login --device-auth` against the persisted `CODEX_HOME`, writes the Codex CLI-compatible `auth.json`, and scheduled Codex app-server runs read that same login.

Persist `CODEX_HOME` for backend containers. If it is unset, the backend uses `$HOME/.codex`. Do not store ChatGPT OAuth cache files, access tokens, or API keys in Convex strategy config or logs.

Run the same app-server and MCP path used by scheduled dry-run strategies before enabling any Codex strategy:

```bash
bun run codex:preflight -- --strategy <strategy-id> --dry-run-only
```

Stored-strategy preflight uses the scheduler provider gate and resolved Convex secrets. It fails closed if the strategy is not dry-run, is not configured for Codex, or lacks the active Codex ChatGPT login.

The Codex app-server path disables inherited apps, plugins, browser/computer/image/multi-agent/workspace tools, shell/unified exec, and web search for strategy runs. Preflight must show only the run-scoped MCP server starting. If any non-run MCP server starts, the run is interrupted and fails closed.

For a synthetic local smoke check that does not load a stored strategy, pass the model and auth mode directly:

```bash
bun run codex:preflight -- --model=your-codex-model --auth-mode=chatgpt
```

After a stored Codex dry-run completes, export audit evidence before enabling rollout:

```bash
bun run codex:run-audit -- --strategy <strategy-id>
```

The command writes `private/audits/codex-run-audit-<run-id>.json` by default and fails closed if provider identity, run/evidence linkage, shared tool logs, canonical strategy tool names, forbidden Codex tool absence, dry-run ledger source run, canonical dry-run accounting state, or provider-sync health cannot be proven. Provider-sync evidence must be healthy, no-drift, and verified at or after the audited run ended.

After at least three scheduled Codex dry-runs complete, export rollout evidence before enabling dashboard creation:

```bash
bun run codex:rollout-audit -- --strategy <strategy-id>
```

The rollout audit writes `private/audits/codex-rollout-audit-<strategy-id>.json` by default and fails closed unless the scheduled dry-run evidence is complete, live Codex strategies remain blocked, run audits pass, summaries/tool logs/accounting diagnostics are comparable, and every enabled non-Codex strategy has post-rollout evidence without provider leakage.

Live Codex execution remains blocked until replay, export audit, and provider-sync evidence has been produced for the intended venue path.

## Dashboard And Auth

- Dashboard users authenticate with Convex Auth
- Backend machine traffic uses `BACKEND_SERVICE_TOKEN` for machine-only Convex actions such as secret resolution
- MT5 worker traffic uses `MT5_WORKER_ACCESS_KEY` on every backend-to-worker request, including health checks
- Kill switches live in Convex and are enforced by the backend runtime

Rotate machine secrets by generating a new value, updating the target service first, then updating the caller, and redeploying both ends so there is no mismatch window.

## Deployment

Deployment-specific scripts and secrets belong in `private/`. The local private deploy script, when configured, can deploy selected surfaces:

```bash
bun private/deploy.ts --only=convex,vercel,mt5
```

After deployment, verify the same runtime paths used in production:

```bash
bun run strategies:diff
bun run provider:identity-preflight
```

For MT5, SSH into the Windows worker host and verify the service manager status plus authenticated `/health` endpoint. Treat the deployment as incomplete until the service is running, the worker returns `status: ok`, and provider-sync evidence is clean.

## Stack

- Bun
- TypeScript
- Turborepo
- Convex
- Next.js
- Vercel AI SDK
- Python for the MT5 worker only

## Open Source Boundary

This repository is intended to publish reusable platform code. Operator-specific strategies, plans, secrets, broker files, deployment details, and production audit artifacts should remain outside version control in `private/`.
