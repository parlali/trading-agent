import { describe, expect, it, vi } from "vitest"
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
    it("persists commit-unknown submissions without a provider order id and never polls them", async () => {
        const persistence = createMemoryOrderPersistence()
        const getOrderStatus = vi.fn(async () => {
            throw new Error("commit-unknown submissions without a provider order id must not be polled")
        })
        const pipeline = new ExecutionPipeline({
            venue: {
                ...createPendingLifecycleVenue(),
                submitOrder: async () => {
                    throw Object.assign(new Error("IPC recv failed"), {
                        executionError: {
                            source: "venue",
                            message: "IPC recv failed",
                            code: "IPC_RECV_FAILED",
                            retryable: true,
                        },
                    })
                },
                getOrderStatus,
            },
            venueName: "mt5",
            policy: {
                dryRun: false,
                safety: {
                    account: {
                        allocationPercent: 100,
                    },
                },
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            lifecycle: {
                pollInterval: 10,
                timeout: 5_000,
            },
            runId: "run-commit-unknown",
            strategyId: "strategy-1",
        })

        const { result, handle } = await pipeline.executeIntent(
            {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 0.01,
                orderType: "limit",
                limitPrice: 4715.5,
                timeInForce: "day",
                metadata: {
                    action: "entry",
                },
            },
            account,
            []
        )

        expect(result.commitOutcome).toBe("commit_unknown")
        expect(result.status).toBe("pending")
        expect(result.orderId).toMatch(/^vmte01/)
        expect(handle?.orderId).toBe(result.orderId)

        const snapshot = persistence.orders.get(result.orderId)
        expect(snapshot).toMatchObject({
            orderId: result.orderId,
            canonicalOrderId: result.orderId,
            providerOrderId: "",
            providerClientOrderId: result.orderId,
            commitOutcome: "commit_unknown",
        })
        expect(persistence.transitions[0]).toMatchObject({
            orderId: result.orderId,
            status: "pending",
            details: expect.objectContaining({
                commitOutcome: "commit_unknown",
            }),
        })

        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(getOrderStatus).not.toHaveBeenCalled()
        pipeline.stopAllTracking()
    })

    it("keeps a failed cancel attempt non-terminal and re-polls until provider truth converges", async () => {
        const persistence = createMemoryOrderPersistence()
        let providerTruth: "pending" | "filled" = "pending"
        const pipeline = new ExecutionPipeline({
            venue: {
                ...createPendingLifecycleVenue(),
                cancelOrder: async () => {
                    providerTruth = "filled"
                    throw new Error("socket closed before cancel acknowledgement")
                },
                getOrderStatus: async (orderId: string) => providerTruth === "filled"
                    ? {
                        orderId,
                        status: "filled",
                        filledQuantity: 1,
                        fillPrice: 105.5,
                        timestamp: 20,
                    }
                    : {
                        orderId,
                        status: "pending",
                        filledQuantity: 0,
                        timestamp: 20,
                    },
            },
            venueName: "mt5",
            policy: {
                dryRun: false,
                safety: {
                    account: {
                        allocationPercent: 100,
                    },
                },
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            lifecycle: {
                pollInterval: 10,
                timeout: 5_000,
            },
            runId: "run-cancel-recovery",
            strategyId: "strategy-1",
        })

        const submitted = await pipeline.executeIntent(
            {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 105,
                timeInForce: "day",
                metadata: {
                    action: "entry",
                },
            },
            account,
            []
        )

        const cancelResult = await pipeline.cancelOrder(submitted.result.orderId, "test cancel failure")
        expect(cancelResult.status).toBe("pending")
        expect(cancelResult.commitOutcome).toBe("commit_unknown")
        expect(cancelResult.error).toContain("socket closed before cancel acknowledgement")

        const afterFailedAttempt = persistence.orders.get(submitted.result.orderId)
        expect(afterFailedAttempt).toMatchObject({
            status: "pending",
            commitOutcome: "commit_unknown",
        })
        expect(afterFailedAttempt?.polling.nextCheckAt).toBeDefined()

        await vi.waitFor(() => {
            expect(persistence.orders.get(submitted.result.orderId)?.status).toBe("filled")
        }, { timeout: 2_000, interval: 10 })

        expect(persistence.orders.get(submitted.result.orderId)).toMatchObject({
            status: "filled",
            filledQuantity: 1,
            avgFillPrice: 105.5,
        })

        pipeline.stopAllTracking()
    })

    it("keeps provider-confirmed cancels terminal", async () => {
        const persistence = createMemoryOrderPersistence()
        const pipeline = new ExecutionPipeline({
            venue: createPendingLifecycleVenue(),
            venueName: "mt5",
            policy: {
                dryRun: false,
                safety: {
                    account: {
                        allocationPercent: 100,
                    },
                },
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            lifecycle: {
                pollInterval: 10,
                timeout: 5_000,
            },
            runId: "run-cancel-confirmed",
            strategyId: "strategy-1",
        })

        const submitted = await pipeline.executeIntent(
            {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 105,
                timeInForce: "day",
                metadata: {
                    action: "entry",
                },
            },
            account,
            []
        )

        const cancelResult = await pipeline.cancelOrder(submitted.result.orderId, "confirmed cancel")
        expect(cancelResult.status).toBe("cancelled")

        const snapshot = persistence.orders.get(submitted.result.orderId)
        expect(snapshot?.status).toBe("cancelled")
        expect(snapshot?.polling.nextCheckAt).toBeUndefined()
        expect(pipeline.getTrackedOrder(submitted.result.orderId)).toBeNull()

        pipeline.stopAllTracking()
    })

    it("keeps a failed modify attempt non-terminal without persisting unconfirmed intent updates", async () => {
        const persistence = createMemoryOrderPersistence()
        let providerTruth: "pending" | "filled" = "pending"
        const pipeline = new ExecutionPipeline({
            venue: {
                ...createPendingLifecycleVenue(),
                modifyOrder: async () => {
                    providerTruth = "filled"
                    throw new Error("connection reset before modify acknowledgement")
                },
                getOrderStatus: async (orderId: string) => providerTruth === "filled"
                    ? {
                        orderId,
                        status: "filled",
                        filledQuantity: 1,
                        fillPrice: 100,
                        timestamp: 20,
                    }
                    : {
                        orderId,
                        status: "pending",
                        filledQuantity: 0,
                        timestamp: 20,
                    },
            },
            venueName: "mt5",
            policy: {
                dryRun: false,
                safety: {
                    account: {
                        allocationPercent: 100,
                    },
                },
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            lifecycle: {
                pollInterval: 10,
                timeout: 5_000,
            },
            runId: "run-modify-recovery",
            strategyId: "strategy-1",
        })

        const submitted = await pipeline.executeIntent(
            {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 100,
                timeInForce: "day",
                metadata: {
                    action: "entry",
                },
            },
            account,
            []
        )

        const modifyResult = await pipeline.modifyOrder(submitted.result.orderId, {
            limitPrice: 101,
        }, "test modify failure")
        expect(modifyResult.status).toBe("pending")
        expect(modifyResult.commitOutcome).toBe("commit_unknown")
        expect(modifyResult.intentUpdates).toBeUndefined()
        expect(modifyResult.error).toContain("connection reset before modify acknowledgement")

        const afterFailedAttempt = persistence.orders.get(submitted.result.orderId)
        expect(afterFailedAttempt).toMatchObject({
            status: "pending",
            commitOutcome: "commit_unknown",
        })
        expect(afterFailedAttempt?.intent.limitPrice).toBe(100)
        expect(afterFailedAttempt?.polling.nextCheckAt).toBeDefined()

        await vi.waitFor(() => {
            expect(persistence.orders.get(submitted.result.orderId)?.status).toBe("filled")
        }, { timeout: 2_000, interval: 10 })

        expect(persistence.orders.get(submitted.result.orderId)).toMatchObject({
            status: "filled",
            filledQuantity: 1,
            avgFillPrice: 100,
        })

        pipeline.stopAllTracking()
    })

    it("keeps one canonical order id across provider replacements and assigns canonical transition sequences", async () => {
        const persistence = createMemoryOrderPersistence()
        const pipeline = new ExecutionPipeline({
            venue: createPendingLifecycleVenue(),
            venueName: "alpaca-options",
            policy: {
                dryRun: false,
                safety: {
                    account: {
                        allocationPercent: 100,
                    },
                },
            },
            riskValidators: [allowIntent],
            logger: createLogger({ minLevel: "fatal" }),
            orderPersistence: persistence.adapter,
            runId: "run-1",
            strategyId: "strategy-1",
        })

        const submitted = await pipeline.executeIntent(
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
        expect(snapshot?.orderId).toBe(submitted.result.orderId)
        expect(snapshot?.providerClientOrderId).toBe(submitted.result.orderId)
        expect(snapshot?.providerOrderId).toBe("provider-entry-2")
        expect(snapshot?.status).toBe("pending")
        expect(snapshot?.lastTransitionSequence).toBe(4)

        expect(persistence.transitions.map((transition) => transition.sequence)).toEqual([1, 2, 3, 4])
        expect(persistence.transitions[0]?.details?.commitOutcome).toBe("commit_unknown")
        expect(persistence.transitions[1]?.details?.commitOutcome).toBe("accepted")
        expect(new Set(persistence.transitions.map((transition) => transition.orderId))).toEqual(new Set([submitted.result.orderId]))
    })

    it("preserves a filled lifecycle when a later modification attempt is rejected", async () => {
        const persistence = createMemoryOrderPersistence()
        const pipeline = new ExecutionPipeline({
            venue: createFilledLifecycleVenue(),
            venueName: "mt5",
            policy: {
                dryRun: false,
                safety: {
                    account: {
                        allocationPercent: 100,
                    },
                },
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
