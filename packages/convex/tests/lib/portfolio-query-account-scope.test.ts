import { describe, expect, it } from "vitest"
import {
    getPortfolioAccountSnapshots,
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

    it("filters provider freshness by account id without requiring app scope", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            provider_sync_state: [
                createFreshnessRow("alpaca-options", "acct-a"),
                createFreshnessRow("polymarket", "acct-b"),
            ],
        })

        const rows = await callRegistered(getPortfolioFreshness, { db } as never, {
            serviceToken: "test-token",
            accountId: "acct-a",
        }) as Array<{ accountId: string }>

        expect(rows).toHaveLength(1)
        expect(rows[0]?.accountId).toBe("acct-a")
    })

    it("filters account snapshots by account id without requiring app scope", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            account_snapshots: [
                createAccountSnapshot("alpaca-options", "acct-a", 100),
                createAccountSnapshot("alpaca-options", "acct-b", 200),
                createAccountSnapshot("polymarket", "acct-a", 300),
            ],
        })

        const rows = await callRegistered(getPortfolioAccountSnapshots, { db } as never, {
            serviceToken: "test-token",
            accountId: "acct-a",
        }) as Array<{ app: string; accountId: string }>

        expect(rows).toEqual([
            expect.objectContaining({
                app: "alpaca-options",
                accountId: "acct-a",
            }),
            expect.objectContaining({
                app: "polymarket",
                accountId: "acct-a",
            }),
        ])
    })

    it("filters provider positions by account id without requiring app scope", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [],
            position_syncs: [],
            provider_positions: [
                createProviderPosition("alpaca-options", "acct-a", "SPY260501C00720000"),
                createProviderPosition("polymarket", "acct-b", "event-token"),
            ],
        })

        const rows = await callRegistered(getPortfolioPositions, { db } as never, {
            serviceToken: "test-token",
            accountId: "acct-a",
        }) as Array<{ accountId: string; instrument: string }>

        expect(rows).toEqual([expect.objectContaining({
            accountId: "acct-a",
            instrument: "SPY260501C00720000",
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

function createFreshnessRow(app: string, accountId: string) {
    return {
        _id: `freshness-${app}-${accountId}`,
        app,
        accountId,
        accountScope: "account",
        providerStatus: "synced",
        stale: false,
        driftDetected: false,
        positionCount: 0,
        pendingOrderCount: 0,
        updatedAt: 100,
    }
}

function createAccountSnapshot(app: string, accountId: string, timestamp: number) {
    return {
        _id: `snapshot-${app}-${accountId}-${timestamp}`,
        app,
        accountId,
        venue: app,
        balance: 100,
        equity: 100,
        buyingPower: 100,
        marginUsed: 0,
        marginAvailable: 100,
        openPnl: 0,
        dayPnl: 0,
        timestamp,
    }
}

function createProviderPosition(app: string, accountId: string, instrument: string) {
    return {
        _id: `provider-position-${app}-${accountId}`,
        app,
        accountId,
        positionKey: instrument,
        ownershipStatus: "owned",
        expectedExternal: true,
        instrument,
        side: "long",
        quantity: 1,
        entryPrice: 1,
        syncedAt: 100,
    }
}
