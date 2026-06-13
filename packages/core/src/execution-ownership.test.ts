import { describe, expect, it } from "vitest"
import { reconcileOwnedInstrumentsFromSnapshots } from "./execution-ownership"
import type { OrderSnapshot } from "./orders"

function createSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
    return {
        orderId: "order-1",
        canonicalOrderId: "order-1",
        providerOrderId: "provider-order-1",
        providerOrderAliases: [],
        commitOutcome: "accepted",
        strategyId: "strategy-1",
        runId: "run-1",
        instrument: "SPY260424P00650000",
        status: "partially_filled",
        action: "entry",
        quantity: 2,
        filledQuantity: 1,
        remainingQuantity: 1,
        submittedAt: 1,
        updatedAt: 1,
        venue: "alpaca-options",
        intent: {
            instrument: "SPY260424P00650000",
            side: "sell",
            quantity: 2,
            orderType: "limit",
            limitPrice: 1.2,
            timeInForce: "day",
        },
        lastTransitionSequence: 0,
        polling: {
            pollIntervalMs: 5_000,
            timeoutMs: 120_000,
            startedAt: 1,
            lastCheckedAt: 1,
        },
        ...overrides,
    }
}

describe("execution ownership reconciliation", () => {
    it("retains entry ownership when a partially filled order is later cancelled", () => {
        const ownedInstruments = new Set(["SPY260424P00650000"])
        const previousSnapshot = createSnapshot()
        const currentSnapshot = createSnapshot({
            status: "cancelled",
            remainingQuantity: 0,
            updatedAt: 2,
        })

        reconcileOwnedInstrumentsFromSnapshots(ownedInstruments, previousSnapshot, currentSnapshot)

        expect(ownedInstruments.has("SPY260424P00650000")).toBe(true)
    })
})
