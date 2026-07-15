import { describe, expect, it } from "vitest"
import { computeRunExecutionOutcomes } from "../../convex/lib/runExecutionOutcomes"
import { upsertOrderRow } from "../../convex/lib/mutations/orders"
import { FakeMutationDb } from "./fakeMutationDb"

const STRATEGY_ID = "strategy-polymarket"
const RUN_ID = "run-polymarket"

const SENATE_TOKEN_ID = "103248970780259540578159872187300945027207380887034914129975330623135033469422"

function createSenateCloseOrder(overrides: Record<string, unknown> = {}) {
    return {
        orderId: "vpmc01ekdb4rfwkp",
        canonicalOrderId: "vpmc01ekdb4rfwkp",
        providerOrderId: "",
        runId: RUN_ID,
        strategyId: STRATEGY_ID,
        app: "polymarket",
        venue: "polymarket",
        instrument: SENATE_TOKEN_ID,
        status: "filled",
        action: "close",
        quantity: 10,
        filledQuantity: 10,
        remainingQuantity: 0,
        avgFillPrice: 0.73,
        submittedAt: 1_000,
        updatedAt: 2_000,
        intent: {
            instrument: SENATE_TOKEN_ID,
            side: "sell",
            quantity: 10,
            orderType: "market",
            metadata: {
                action: "close",
                entryPrice: 0.77,
                positionSide: "long",
                outcome: "No",
            },
        },
        lastTransitionSequence: 1,
        ...overrides,
    }
}

describe("run execution outcomes", () => {
    it("derives realized pnl for the two-part Senate loss-cap close from canonical order records", () => {
        const outcomes = computeRunExecutionOutcomes([
            createSenateCloseOrder(),
            createSenateCloseOrder({
                orderId: "vpmc02itdnvqs552",
                canonicalOrderId: "vpmc02itdnvqs552",
                avgFillPrice: 0.7546,
            }),
        ] as never)

        expect(outcomes.opportunitySubmitted).toBe(2)
        expect(outcomes.opportunityFilled).toBe(2)
        expect(outcomes.opportunityClosed).toBe(2)
        expect(outcomes.opportunityRealizedPnl).toBeCloseTo(-0.554, 10)
    })

    it("excludes rejected orders and unfilled working orders from fill outcomes", () => {
        const outcomes = computeRunExecutionOutcomes([
            createSenateCloseOrder({ status: "rejected", filledQuantity: 0 }),
            createSenateCloseOrder({
                orderId: "vpme01workingorder",
                action: "entry",
                status: "pending",
                filledQuantity: 0,
                avgFillPrice: undefined,
            }),
        ] as never)

        expect(outcomes.opportunitySubmitted).toBe(1)
        expect(outcomes.opportunityFilled).toBe(0)
        expect(outcomes.opportunityClosed).toBe(0)
        expect(outcomes.opportunityRealizedPnl).toBe(0)
    })

    it("patches run counters when a working order fills after the run already completed", async () => {
        const db = new FakeMutationDb({
            strategies: [{
                _id: STRATEGY_ID,
                app: "polymarket",
                accountId: "primary",
                name: "PM strategy",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: RUN_ID,
                strategyId: STRATEGY_ID,
                app: "polymarket",
                status: "completed",
                startedAt: 500,
                endedAt: 1_500,
                opportunitySubmitted: 1,
                opportunityFilled: 0,
                opportunityClosed: 0,
                opportunityRealizedPnl: 0,
            }],
            orders: [],
            order_identity_aliases: [],
            instrument_claims: [],
            control_plane_metrics: [],
        })
        const ctx = { db }

        await upsertOrderRow(ctx as never, createSenateCloseOrder({
            accountId: "primary",
            status: "pending",
            filledQuantity: 0,
            avgFillPrice: undefined,
        }) as never)

        const runAfterSubmit = (db.rows.strategy_runs ?? [])[0]
        expect(runAfterSubmit).toMatchObject({
            opportunitySubmitted: 1,
            opportunityFilled: 0,
        })

        await upsertOrderRow(ctx as never, createSenateCloseOrder({
            accountId: "primary",
            updatedAt: 3_000,
        }) as never)

        const runAfterFill = (db.rows.strategy_runs ?? [])[0]
        expect(runAfterFill).toMatchObject({
            opportunitySubmitted: 1,
            opportunityFilled: 1,
            opportunityClosed: 1,
        })
        expect(runAfterFill?.opportunityRealizedPnl).toBeCloseTo(-0.4, 10)
    })
})
