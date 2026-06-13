import { describe, expect, it, vi } from "vitest"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import { createAlpacaProposeCloseTool } from "./propose-close"

describe("createAlpacaProposeCloseTool", () => {
    it("resolves Alpaca structure close estimated price before closing", async () => {
        const closePosition = vi.fn(async () => ({
            result: {
                orderId: "close-order",
                status: "filled" as const,
                filledQuantity: 1,
                fillPrice: 0.42,
                timestamp: Date.now(),
            },
            validation: {
                allowed: true,
            },
        }))
        const pipeline = {
            getPositions: vi.fn(async () => []),
            closePosition,
            getAccountState: vi.fn(),
            executeIntent: vi.fn(),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            getOrderStatus: vi.fn(),
            getWorkingOrders: vi.fn(),
            getRecentPositionClosures: vi.fn(),
            getAccountPnlEvents: vi.fn(),
        } as unknown as ExecutionPipeline
        const venue = {
            buildCloseIntent: vi.fn(async (): Promise<OrderIntent> => ({
                instrument: "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00649000|SPY260424P00650000",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 0.43,
                timeInForce: "day",
                metadata: {
                    estimatedPrice: 0.41,
                },
            })),
        }

        const tool = createAlpacaProposeCloseTool(pipeline, venue as never)
        await tool.handler({
            instrument: "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00649000|SPY260424P00650000",
            reason: "target reached",
        })

        expect(venue.buildCloseIntent).toHaveBeenCalledWith("VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00649000|SPY260424P00650000")
        expect(closePosition).toHaveBeenCalledWith(
            "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00649000|SPY260424P00650000",
            "target reached",
            {
                estimatedPrice: 0.41,
            }
        )
    })
})
