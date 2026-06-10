import { describe, expect, it } from "vitest"
import { upsertOrderRow } from "../../convex/lib/mutations/orders"
import { FakeMutationDb } from "./fakeMutationDb"

const STRATEGY_ID = "strategy-mt5"
const RUN_ID = "run-mt5"

function createDb(orderOverrides: Record<string, unknown> = {}) {
    return new FakeMutationDb({
        strategies: [{
            _id: STRATEGY_ID,
            app: "mt5",
            name: "MT5 strategy",
            policy: { dryRun: false },
        }],
        orders: [{
            _id: "order-row",
            orderId: "vmte01abcdefghij",
            canonicalOrderId: "vmte01abcdefghij",
            providerOrderId: "1671367552",
            providerClientOrderId: "vmte01abcdefghij",
            providerOrderAliases: [],
            commitOutcome: "accepted",
            runId: RUN_ID,
            strategyId: STRATEGY_ID,
            app: "mt5",
            venue: "mt5",
            instrument: "US30",
            status: "filled",
            action: "entry",
            quantity: 0.1,
            filledQuantity: 0.1,
            remainingQuantity: 0,
            avgFillPrice: 50659.1,
            submittedAt: 1_000,
            updatedAt: 2_000,
            intent: {
                instrument: "US30",
                side: "buy",
                quantity: 0.1,
                orderType: "market",
            },
            lastTransitionSequence: 2,
            polling: {
                pollIntervalMs: 5_000,
                timeoutMs: 120_000,
                startedAt: 1_000,
                lastCheckedAt: 2_000,
            },
            ...orderOverrides,
        }],
        instrument_claims: [],
        control_plane_metrics: [],
    })
}

function buildUpsertArgs(overrides: Record<string, unknown> = {}) {
    return {
        orderId: "vmte01abcdefghij",
        canonicalOrderId: "vmte01abcdefghij",
        providerOrderId: "1671367552",
        providerClientOrderId: "vmte01abcdefghij",
        providerOrderAliases: [],
        commitOutcome: "accepted",
        runId: RUN_ID,
        strategyId: STRATEGY_ID,
        venue: "mt5",
        instrument: "US30",
        status: "pending",
        action: "entry",
        quantity: 0.1,
        filledQuantity: 0,
        remainingQuantity: 0.1,
        avgFillPrice: undefined,
        submittedAt: 1_000,
        updatedAt: 3_000,
        intent: {
            instrument: "US30",
            side: "buy",
            quantity: 0.1,
            orderType: "market",
        },
        lastTransitionSequence: 0,
        polling: {
            pollIntervalMs: 5_000,
            timeoutMs: 120_000,
            startedAt: 1_000,
            lastCheckedAt: 3_000,
        },
        ...overrides,
    } as never
}

function getOrderRow(db: FakeMutationDb) {
    const row = (db.rows.orders ?? []).find((order) => order._id === "order-row")
    if (!row) {
        throw new Error("Expected seeded order row")
    }
    return row
}

describe("order persistence terminal-state monotonicity", () => {
    it("blocks a stale non-terminal write from regressing a provider-confirmed filled order", async () => {
        const db = createDb()
        const ctx = { db } as never

        await upsertOrderRow(ctx, buildUpsertArgs({ status: "pending", filledQuantity: 0 }))

        const row = getOrderRow(db)
        expect(row.status).toBe("filled")
        expect(row.filledQuantity).toBe(0.1)
        expect(row.avgFillPrice).toBe(50659.1)
        expect(row.updatedAt).toBe(2_000)

        const metric = (db.rows.control_plane_metrics ?? []).find((entry) =>
            entry.metric === "upsert_order.terminal_regression_blocked"
        )
        expect(metric?.value).toBe(1)
    })

    it("blocks regressions for every provider-confirmed terminal status", async () => {
        for (const status of ["filled", "cancelled", "rejected", "expired"]) {
            const db = createDb({ status })
            await upsertOrderRow({ db } as never, buildUpsertArgs({ status: "partially_filled" }))
            expect(getOrderRow(db).status).toBe(status)
        }
    })

    it("allows terminal-to-terminal provider-truth corrections", async () => {
        const db = createDb({ status: "cancelled", filledQuantity: 0 })
        const ctx = { db } as never

        await upsertOrderRow(ctx, buildUpsertArgs({
            status: "filled",
            filledQuantity: 0.1,
            remainingQuantity: 0,
            avgFillPrice: 50659.1,
        }))

        const row = getOrderRow(db)
        expect(row.status).toBe("filled")
        expect(row.filledQuantity).toBe(0.1)
    })

    it("allows recovery to rewrite commit-unknown rows even when the status looks terminal", async () => {
        const db = createDb({ status: "rejected", commitOutcome: "commit_unknown" })
        const ctx = { db } as never

        await upsertOrderRow(ctx, buildUpsertArgs({
            status: "pending",
            commitOutcome: "recovered",
        }))

        const row = getOrderRow(db)
        expect(row.status).toBe("pending")
        expect(row.commitOutcome).toBe("recovered")
    })

    it("allows timed-out orders to resume because they are not provider-confirmed terminal", async () => {
        const db = createDb({ status: "timed_out" })
        const ctx = { db } as never

        await upsertOrderRow(ctx, buildUpsertArgs({ status: "pending" }))

        expect(getOrderRow(db).status).toBe("pending")
    })

    it("allows normal forward progress from pending to filled", async () => {
        const db = createDb({ status: "pending", filledQuantity: 0, avgFillPrice: undefined })
        const ctx = { db } as never

        await upsertOrderRow(ctx, buildUpsertArgs({
            status: "filled",
            filledQuantity: 0.1,
            remainingQuantity: 0,
            avgFillPrice: 50700,
        }))

        const row = getOrderRow(db)
        expect(row.status).toBe("filled")
        expect(row.filledQuantity).toBe(0.1)
        expect(row.avgFillPrice).toBe(50700)
    })
})
