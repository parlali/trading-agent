import { describe, expect, it, vi } from "vitest"
import type { OrderSnapshot } from "@valiq-trading/core"
import { reconcilePendingOrdersForRun } from "./pending-orders"

function createSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
    const now = Date.parse("2026-04-20T08:00:00.000Z")
    return {
        orderId: "order-1",
        providerOrderId: "order-1",
        providerOrderAliases: [],
        strategyId: "strategy-1",
        runId: "run-1",
        instrument: "BTC-USDT-SWAP",
        status: "pending",
        action: "entry",
        quantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        submittedAt: now,
        updatedAt: now,
        venue: "okx",
        intent: {
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
        lastTransitionSequence: 0,
        polling: {
            pollIntervalMs: 1000,
            timeoutMs: 60_000,
            startedAt: now,
            lastCheckedAt: now,
        },
        ...overrides,
    }
}

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        fatal: vi.fn(),
    }
}

describe("reconcilePendingOrdersForRun", () => {
    it("cancels TTL-expired pending entries before run", async () => {
        const pipeline = {
            cancelOrder: vi.fn().mockResolvedValue({ status: "cancelled" }),
            getOrderStatus: vi.fn(),
            getOrderSnapshot: vi.fn(),
            resumeOpenOrders: vi.fn(),
        }
        const persistence = {
            listActiveOrders: vi.fn().mockResolvedValue([
                createSnapshot({
                    orderId: "order-expired",
                    intent: {
                        instrument: "BTC-USDT-SWAP",
                        side: "buy",
                        quantity: 1,
                        orderType: "limit",
                        limitPrice: 100,
                        timeInForce: "gtc",
                        metadata: {
                            action: "entry",
                            cancelAt: 0,
                        },
                    },
                }),
            ]),
        }

        const result = await reconcilePendingOrdersForRun(
            pipeline,
            "strategy-1",
            persistence,
            createLogger() as never
        )

        expect(pipeline.cancelOrder).toHaveBeenCalledWith(
            "order-expired",
            "Provider working-order TTL expired"
        )
        expect(result.pendingOrders).toHaveLength(0)
        expect(result.blockedInstruments).toEqual([])
    })

    it("blocks new entries on the instrument when TTL cancellation cannot be reconciled", async () => {
        const pipeline = {
            cancelOrder: vi.fn().mockRejectedValue(new Error("order not found")),
            getOrderStatus: vi.fn(),
            getOrderSnapshot: vi.fn(),
            resumeOpenOrders: vi.fn(),
        }
        const persistence = {
            listActiveOrders: vi.fn().mockResolvedValue([
                createSnapshot({
                    orderId: "order-expired",
                    intent: {
                        instrument: "BTC-USDT-SWAP",
                        side: "buy",
                        quantity: 1,
                        orderType: "limit",
                        limitPrice: 100,
                        timeInForce: "gtc",
                        metadata: {
                            action: "entry",
                            cancelAt: 0,
                        },
                    },
                }),
            ]),
        }

        const result = await reconcilePendingOrdersForRun(
            pipeline,
            "strategy-1",
            persistence,
            createLogger() as never
        )

        expect(result.pendingOrders).toHaveLength(0)
        expect(result.runtimeContextLines[0]).toContain("New entries and size-ins on BTC-USDT-SWAP are blocked this run")
        expect(result.blockedInstruments).toEqual(["BTC-USDT-SWAP"])
        expect(pipeline.getOrderStatus).not.toHaveBeenCalled()
    })

    it("blocks new entries on the instrument when provider refresh fails for an unknown order id", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            getOrderStatus: vi.fn().mockRejectedValue(new Error("order not found")),
            getOrderSnapshot: vi.fn(),
            resumeOpenOrders: vi.fn(),
        }
        const persistence = {
            listActiveOrders: vi.fn().mockResolvedValue([
                createSnapshot({ orderId: "order-unknown" }),
            ]),
        }

        const result = await reconcilePendingOrdersForRun(
            pipeline,
            "strategy-1",
            persistence,
            createLogger() as never
        )

        expect(result.runtimeContextLines).toEqual([
            "Active order refresh failed at run start for order-unknown. New entries and size-ins on BTC-USDT-SWAP are blocked this run until provider state is reconciled.",
        ])
        expect(result.pendingOrders).toHaveLength(0)
        expect(result.blockedInstruments).toEqual(["BTC-USDT-SWAP"])
        expect(pipeline.resumeOpenOrders).not.toHaveBeenCalled()
    })

    it("drops provider-terminal tracked orders and resumes only still-live working orders", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            getOrderStatus: vi.fn().mockResolvedValue({ status: "cancelled" }),
            getOrderSnapshot: vi
                .fn()
                .mockResolvedValueOnce(createSnapshot({ orderId: "order-live", status: "pending" }))
                .mockResolvedValueOnce(createSnapshot({ orderId: "order-terminal", status: "cancelled" })),
            resumeOpenOrders: vi.fn().mockResolvedValue([]),
        }
        const persistence = {
            listActiveOrders: vi.fn().mockResolvedValue([
                createSnapshot({ orderId: "order-live" }),
                createSnapshot({ orderId: "order-terminal" }),
            ]),
        }

        const result = await reconcilePendingOrdersForRun(
            pipeline,
            "strategy-1",
            persistence,
            createLogger() as never
        )

        expect(result.pendingOrders).toHaveLength(1)
        expect(result.pendingOrders[0]?.orderId).toBe("order-live")
        expect(result.blockedInstruments).toEqual([])
        expect(pipeline.resumeOpenOrders).toHaveBeenCalledTimes(1)
    })
})
