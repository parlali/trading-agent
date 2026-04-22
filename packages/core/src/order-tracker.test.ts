import { describe, expect, it } from "vitest"
import { ExecutionPipeline, type VenueAdapter } from "./execution.ts"
import { createLogger } from "./logger.ts"
import { matchesOrderIdentifier, type OrderPersistenceAdapter, type OrderSnapshot, type OrderTransition } from "./orders.ts"
import type { AccountState, OrderIntent, ValidationResult } from "./types.ts"

const account: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

function allowIntent(
    intent: OrderIntent
): ValidationResult {
    return {
        allowed: true,
        adjustedIntent: intent,
    }
}

function createMemoryOrderPersistence() {
    const orders = new Map<string, OrderSnapshot>()
    const transitions: OrderTransition[] = []

    const adapter: OrderPersistenceAdapter = {
        upsertOrder: async (snapshot) => {
            orders.set(snapshot.orderId, snapshot)
        },
        logOrderTransition: async (transition) => {
            const existing = orders.get(transition.orderId)
            if (!existing) {
                throw new Error(`Unknown order ${transition.orderId}`)
            }

            const sequence = existing.lastTransitionSequence + 1
            const nextSnapshot = {
                ...existing,
                lastTransitionSequence: sequence,
            }
            orders.set(existing.orderId, nextSnapshot)
            transitions.push({
                ...transition,
                sequence,
            })
            return sequence
        },
        getOrder: async (orderId) => {
            const direct = orders.get(orderId)
            if (direct) {
                return direct
            }

            return Array.from(orders.values()).find((snapshot) => matchesOrderIdentifier(snapshot, orderId)) ?? null
        },
        listActiveOrders: async (strategyId) => {
            return Array.from(orders.values()).filter((order) =>
                order.strategyId === strategyId &&
                (order.status === "pending" || order.status === "partially_filled")
            )
        },
    }

    return {
        adapter,
        orders,
        transitions,
    }
}

function createPendingLifecycleVenue(): VenueAdapter {
    return {
        getPositions: async () => [],
        getAccountState: async () => account,
        submitOrder: async () => ({
            orderId: "provider-entry-1",
            status: "pending",
            filledQuantity: 0,
            timestamp: 1,
        }),
        cancelOrder: async (orderId: string) => ({
            orderId,
            status: "cancelled",
            filledQuantity: 0,
            timestamp: 99,
        }),
        modifyOrder: async (orderId: string) => {
            expect(orderId).toBe("provider-entry-1")
            return {
                orderId: "provider-entry-2",
                status: "pending",
                filledQuantity: 0,
                timestamp: 2,
            }
        },
        closePosition: async (instrument: string) => ({
            orderId: `close-${instrument}`,
            status: "filled",
            filledQuantity: 1,
            timestamp: 3,
        }),
        getOrderStatus: async (orderId: string) => ({
            orderId,
            status: "pending",
            filledQuantity: 0,
            timestamp: 4,
        }),
    }
}

function createFilledLifecycleVenue(): VenueAdapter {
    return {
        getPositions: async () => [],
        getAccountState: async () => account,
        submitOrder: async () => ({
            orderId: "filled-entry-1",
            status: "filled",
            filledQuantity: 1,
            fillPrice: 100,
            timestamp: 10,
        }),
        cancelOrder: async (orderId: string) => ({
            orderId,
            status: "cancelled",
            filledQuantity: 0,
            timestamp: 11,
        }),
        modifyOrder: async (orderId: string) => {
            expect(orderId).toBe("filled-entry-1")
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: 12,
                error: "No changes",
            }
        },
        closePosition: async (instrument: string) => ({
            orderId: `close-${instrument}`,
            status: "filled",
            filledQuantity: 1,
            timestamp: 13,
        }),
        getOrderStatus: async (orderId: string) => ({
            orderId,
            status: "filled",
            filledQuantity: 1,
            fillPrice: 100,
            timestamp: 14,
        }),
    }
}

describe("order lifecycle persistence", () => {
    it("keeps one canonical order id across provider replacements and assigns canonical transition sequences", async () => {
        const persistence = createMemoryOrderPersistence()
        const pipeline = new ExecutionPipeline({
            venue: createPendingLifecycleVenue(),
            venueName: "alpaca-options",
            policy: {
                dryRun: false,
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            runId: "run-1",
            strategyId: "strategy-1",
        })

        await pipeline.executeIntent(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 100,
                timeInForce: "gtc",
                metadata: {
                    action: "entry",
                },
            },
            account,
            []
        )

        await pipeline.modifyOrder("provider-entry-1", {
            limitPrice: 101,
        }, "price improvement")

        const snapshot = await pipeline.getOrderSnapshot("provider-entry-1")
        expect(snapshot).not.toBeNull()
        expect(snapshot?.orderId).toBe("provider-entry-1")
        expect(snapshot?.providerOrderId).toBe("provider-entry-2")
        expect(snapshot?.status).toBe("pending")
        expect(snapshot?.lastTransitionSequence).toBe(3)

        expect(persistence.transitions.map((transition) => transition.sequence)).toEqual([1, 2, 3])
        expect(new Set(persistence.transitions.map((transition) => transition.orderId))).toEqual(new Set(["provider-entry-1"]))
    })

    it("preserves a filled lifecycle when a later modification attempt is rejected", async () => {
        const persistence = createMemoryOrderPersistence()
        const pipeline = new ExecutionPipeline({
            venue: createFilledLifecycleVenue(),
            venueName: "mt5",
            policy: {
                dryRun: false,
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            runId: "run-2",
            strategyId: "strategy-1",
        })

        await pipeline.executeIntent(
            {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 1,
                orderType: "market",
                timeInForce: "day",
                metadata: {
                    action: "entry",
                },
            },
            account,
            []
        )

        const result = await pipeline.modifyOrder("filled-entry-1", {
            stopPrice: 95,
        }, "tighten protection")

        const snapshot = await pipeline.getOrderSnapshot("filled-entry-1")
        expect(result.status).toBe("filled")
        expect(result.fillPrice).toBe(100)
        expect(result.error).toBe("No changes")
        expect(snapshot?.status).toBe("filled")
        expect(snapshot?.avgFillPrice).toBe(100)
        expect(snapshot?.intent.stopPrice).toBeUndefined()
    })
})
