import { describe, expect, it } from "vitest"
import {
    reconcileOwnedInstrumentsFromSnapshots,
    reconcileOwnershipScopeFromSnapshot,
} from "./execution-ownership"
import type { OrderSnapshot } from "./orders"
import type { ProviderOwnershipScope } from "./position-filter"

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

    it("scopes an intra-run entry by exact key once the provider reports the position id", () => {
        const scope: ProviderOwnershipScope = {
            instruments: new Set(["XAUUSD"]),
            positionKeys: new Set(["XAUUSD:1600700000"]),
            workingOrderIds: new Set(),
        }
        const snapshot = createSnapshot({
            instrument: "XAUUSD",
            status: "filled",
            filledQuantity: 2,
            remainingQuantity: 0,
            intent: {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 2,
                orderType: "market",
                timeInForce: "ioc",
                metadata: {
                    providerPositionId: "1830194335",
                },
            },
        })

        reconcileOwnershipScopeFromSnapshot(scope, snapshot)

        expect(scope.positionKeys.has("XAUUSD:1830194335")).toBe(true)
        expect(scope.instrumentFallbackUnlocks).toBeUndefined()
    })

    it("unlocks instrument fallback for an intra-run entry the provider does not key", () => {
        const scope: ProviderOwnershipScope = {
            instruments: new Set(["BTC-USDT-SWAP"]),
            positionKeys: new Set(["BTC-USDT-SWAP:1600700000"]),
            workingOrderIds: new Set(),
        }
        const snapshot = createSnapshot({
            instrument: "BTC-USDT-SWAP",
            status: "filled",
            filledQuantity: 2,
            remainingQuantity: 0,
            intent: {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                quantity: 2,
                orderType: "market",
                timeInForce: "ioc",
            },
        })

        reconcileOwnershipScopeFromSnapshot(scope, snapshot)

        expect(scope.instrumentFallbackUnlocks).toEqual(new Set(["BTC-USDT-SWAP"]))
        expect(scope.positionKeys).toEqual(new Set(["BTC-USDT-SWAP:1600700000"]))
    })
})
