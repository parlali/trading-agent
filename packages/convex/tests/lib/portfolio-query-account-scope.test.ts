import { describe, expect, it } from "vitest"
import {
    getPortfolioFreshness,
    getPortfolioPositions,
} from "../../convex/lib/queries/portfolio"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("portfolio query account scope", () => {
    it("preserves requested account id when provider freshness row is missing", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            provider_sync_state: [],
        })

        const rows = await callRegistered(getPortfolioFreshness, { db } as never, {
            serviceToken: "test-token",
            app: "alpaca-options",
            accountId: "acct-requested",
        }) as Array<{ accountId: string; providerStatus: string; stale: boolean }>

        expect(rows).toEqual([expect.objectContaining({
            accountId: "acct-requested",
            providerStatus: "stale",
            stale: true,
        })])
    })

    it("does not mix dry-run virtual positions across requested accounts", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [
                {
                    _id: "strategy-a",
                    app: "alpaca-options",
                    accountId: "acct-a",
                    name: "Account A dry run",
                    policy: { dryRun: true },
                },
                {
                    _id: "strategy-b",
                    app: "alpaca-options",
                    accountId: "acct-b",
                    name: "Account B dry run",
                    policy: { dryRun: true },
                },
            ],
            provider_positions: [],
            position_syncs: [
                {
                    _id: "sync-a",
                    strategyId: "strategy-a",
                    app: "alpaca-options",
                    accountId: "acct-a",
                    syncedAt: 100,
                    positionCount: 1,
                },
                {
                    _id: "sync-b",
                    strategyId: "strategy-b",
                    app: "alpaca-options",
                    accountId: "acct-b",
                    syncedAt: 100,
                    positionCount: 1,
                },
            ],
            positions: [
                createDryRunPosition({
                    strategyId: "strategy-a",
                    accountId: "acct-a",
                    instrument: "SPY260501C00720000",
                }),
                createDryRunPosition({
                    strategyId: "strategy-b",
                    accountId: "acct-b",
                    instrument: "SPY260501P00690000",
                }),
            ],
        })

        const rows = await callRegistered(getPortfolioPositions, { db } as never, {
            serviceToken: "test-token",
            app: "alpaca-options",
            accountId: "acct-a",
        }) as Array<{ accountId: string; instrument: string; metadata?: Record<string, unknown> }>

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            accountId: "acct-a",
            instrument: "SPY260501C00720000",
            metadata: {
                dryRun: true,
                source: "strategy_virtual_position",
            },
        })
    })
})

function createDryRunPosition(args: {
    strategyId: string
    accountId: string
    instrument: string
}) {
    return {
        _id: `position-${args.strategyId}`,
        strategyId: args.strategyId,
        app: "alpaca-options",
        accountId: args.accountId,
        positionKey: args.instrument,
        instrument: args.instrument,
        side: "long",
        quantity: 1,
        entryPrice: 1,
        syncedAt: 100,
    }
}
