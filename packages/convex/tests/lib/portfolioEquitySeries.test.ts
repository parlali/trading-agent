import { describe, expect, it } from "vitest"
import { getPortfolioEquitySeries } from "../../convex/lib/queries/portfolio"
import { callRegisteredQuery, type FakeRow } from "./fakeQueryDb"

type EquitySeriesResult = {
    series: Array<{ timestamp: number; total: number; providers: Record<string, number> }>
    latest: { timestamp: number; total: number; providers: Record<string, number> } | null
}

function createSnapshot(args: {
    id: string
    app: string
    accountId?: string
    timestamp: number
    equity: number
}): FakeRow {
    return {
        _id: args.id,
        app: args.app,
        accountId: args.accountId,
        venue: args.app,
        balance: args.equity,
        openPnl: 0,
        equity: args.equity,
        timestamp: args.timestamp,
    }
}

async function callEquitySeries(
    rows: Record<string, FakeRow[]>,
    args: Record<string, unknown>
): Promise<EquitySeriesResult> {
    return await callRegisteredQuery(getPortfolioEquitySeries, rows, args) as EquitySeriesResult
}

describe("getPortfolioEquitySeries", () => {
    it("sums the latest equity per account instead of overwriting accounts within an app", async () => {
        const result = await callEquitySeries({
            account_snapshots: [
                createSnapshot({ id: "snap-1", app: "okx-swap", accountId: "acct-a", timestamp: 1000, equity: 100 }),
                createSnapshot({ id: "snap-2", app: "okx-swap", accountId: "acct-b", timestamp: 2000, equity: 50 }),
                createSnapshot({ id: "snap-3", app: "okx-swap", accountId: "acct-a", timestamp: 3000, equity: 110 }),
            ],
        }, {
            app: "okx-swap",
            timeRange: "all",
        })

        expect(result.series.map((point) => point.total)).toEqual([100, 150, 160])
        expect(result.latest?.total).toBe(160)
        expect(result.latest?.providers).toEqual({ "okx-swap": 160 })
    })

    it("counts legacy snapshots without accountId once as a single bucket per app", async () => {
        const result = await callEquitySeries({
            account_snapshots: [
                createSnapshot({ id: "snap-1", app: "mt5", timestamp: 1000, equity: 70 }),
                createSnapshot({ id: "snap-2", app: "mt5", timestamp: 2000, equity: 80 }),
                createSnapshot({ id: "snap-3", app: "mt5", accountId: "acct-a", timestamp: 3000, equity: 25 }),
            ],
        }, {
            app: "mt5",
            timeRange: "all",
        })

        expect(result.series.map((point) => point.total)).toEqual([70, 80, 105])
        expect(result.latest?.providers).toEqual({ mt5: 105 })
    })

    it("seeds one baseline per account before the range start", async () => {
        const end = Date.now()
        const result = await callEquitySeries({
            accounts: [
                { _id: "acct-row-a", app: "okx-swap", accountId: "acct-a" },
                { _id: "acct-row-b", app: "okx-swap", accountId: "acct-b" },
            ],
            account_snapshots: [
                createSnapshot({
                    id: "snap-base-a-old",
                    app: "okx-swap",
                    accountId: "acct-a",
                    timestamp: end - 40 * 60 * 60 * 1000,
                    equity: 90,
                }),
                createSnapshot({
                    id: "snap-base-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                    timestamp: end - 30 * 60 * 60 * 1000,
                    equity: 100,
                }),
                createSnapshot({
                    id: "snap-base-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                    timestamp: end - 28 * 60 * 60 * 1000,
                    equity: 50,
                }),
                createSnapshot({
                    id: "snap-in-range-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                    timestamp: end - 60 * 60 * 1000,
                    equity: 120,
                }),
            ],
        }, {
            app: "okx-swap",
            timeRange: "24h",
        })

        expect(result.series).toHaveLength(1)
        expect(result.series[0]?.total).toBe(170)
        expect(result.latest?.providers).toEqual({ "okx-swap": 170 })
    })
})
