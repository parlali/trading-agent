Always use bun to run commands.
Always use typescript over javascript.
Always use 4 spaces to indent code.
Never use semicolons when its optional for the language.
Never write inline comments in code.
No Emojis anywhere.

When working on plan.md tasks:
  - ALWAYS check off completed tasks: `- [ ]` becomes `- [x]`
  - Add brief notes in parentheses if task was skipped or modified
  - The plan is the source of truth for progress tracking

never duplicate logic
never create multiple sources of truth
always clean up redundant code

## Architecture

```
Web App (Next.js) -> Convex (backend) -> Windows VPS (mt5-worker)
```

- Convex controls sync scheduling, backfill windowing, all orchestration logic
- Worker is stateless: receives account + time window, connects to MT5, posts results back
- Worker reports 2 statuses per sync: "connected" (with account info) then "ok"/"error" (with trade counts)
- Backfill: Convex sends 30-day windows walking backward until 0 trades returned
- Trades upserted by externalId (safe to re-fetch overlapping windows)

## Key paths

- `apps/web/app/(authenticated)/dashboard/page.tsx` -- main analytics dashboard
- `apps/web/app/(authenticated)/trades/page.tsx` -- trade history
- `apps/web/app/(authenticated)/journal/page.tsx` -- trading journal
- `apps/web/app/(authenticated)/edge/page.tsx` -- edge analysis
- `apps/web/app/(authenticated)/drawdown/page.tsx` -- drawdown and streak analysis
- `apps/web/app/(authenticated)/what-if/page.tsx` -- discipline and scenario analysis
- `apps/web/app/(authenticated)/projections/page.tsx` -- monte carlo and risk of ruin
- `apps/web/app/(authenticated)/positions/page.tsx` -- open positions and exposure
- `apps/web/app/(authenticated)/settings/mt5-connection/page.tsx` -- credentials + connection UI
- `packages/convex/convex/schema.ts` -- database schema
- `packages/convex/convex/mt5Credentials.ts` -- credentials CRUD, sync scheduling, backfill logic
- `packages/convex/convex/trading.ts` -- dashboard data queries
- `packages/convex/convex/analytics.ts` -- behavioral/risk analytics queries
- `packages/convex/convex/journal.ts` -- journal entries and trade comments
- `packages/convex/convex/tradingIngest.ts` -- trade/position upsert logic
- `packages/convex/convex/http.ts` -- worker HTTP endpoints (accounts, ingest, sync-status, add-broker)
- `packages/convex/convex/cacheWriter.ts` -- dashboard + analytics cache computation
- `apps/mt5-worker/src/worker.py` -- main worker loop, sync orchestration
- `apps/mt5-worker/src/mt5_client.py` -- MT5 API wrapper
- `apps/mt5-worker/src/config.py` -- worker settings
- `apps/mt5-worker/src/add_broker.py` -- broker provisioning via GUI automation
- `apps/mt5-worker/src/sync_dat.py` -- sync servers.dat to portable instances

## Seeding dev with prod data

Copy all prod data (users, trades, accounts, etc.) into your dev Convex deployment:

```
cd packages/convex && bun run seed-dev
```

This exports a snapshot from prod, imports it into dev with `--replace-all`, then cleans up.

## MT5 Worker deployment

Windows VM at ${{ secrets.MT5_WORKER_VM_HOST }}. Service managed by nssm.
Keep deployment steps in private operator docs.
