import { describe, expect, it, vi } from "vitest"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import {
    createAlpacaProposeCloseTool,
    createMT5ProposeCloseTool,
    createOKXProposeCloseTool,
} from "./propose-close"

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

    it("closes an exact Alpaca provider position when identity is provided", async () => {
        const position = {
            instrument: "SPY260626P00730000",
            providerPositionId: "SPY260626P00730000",
            side: "short" as const,
            quantity: 1,
            entryPrice: 1.79,
            currentPrice: 0.02,
            metadata: {},
        }
        const closeProviderPosition = vi.fn(async () => ({
            result: {
                orderId: "alpaca-close",
                status: "filled" as const,
                filledQuantity: 1,
                fillPrice: 0.02,
                timestamp: Date.now(),
            },
            validation: {
                allowed: true,
            },
        }))
        const pipeline = {
            getPositions: vi.fn(async () => [position]),
            closeProviderPosition,
        } as unknown as ExecutionPipeline
        const venue = {
            buildCloseIntent: vi.fn(),
        }

        const tool = createAlpacaProposeCloseTool(pipeline, venue as never)
        const result = await tool.handler({
            instrument: "SPY260626P00730000",
            providerPositionId: "SPY260626P00730000",
            reason: "expiry risk",
        }) as { status: string; providerPositionKey?: string }

        expect(result.status).toBe("filled")
        expect(result.providerPositionKey).toBe("SPY260626P00730000:short")
        expect(venue.buildCloseIntent).not.toHaveBeenCalled()
        expect(closeProviderPosition).toHaveBeenCalledWith(
            position,
            "expiry risk",
            {
                estimatedPrice: 0.02,
            }
        )
    })
})

describe("createMT5ProposeCloseTool", () => {
    function createMT5Pipeline() {
        const firstPosition = {
            instrument: "EURUSD",
            providerPositionId: "111",
            side: "long" as const,
            quantity: 0.01,
            entryPrice: 1.1,
            currentPrice: 1.101,
            metadata: {
                ticket: 222,
                identifier: 111,
            },
        }
        const secondPosition = {
            instrument: "EURUSD",
            providerPositionId: "333",
            side: "short" as const,
            quantity: 0.01,
            entryPrice: 1.102,
            currentPrice: 1.101,
            metadata: {
                ticket: 444,
                identifier: 333,
            },
        }
        const closeProviderPosition = vi.fn(async () => ({
            result: {
                orderId: "vmtc01close",
                status: "filled" as const,
                filledQuantity: 0.01,
                fillPrice: 1.101,
                timestamp: Date.now(),
            },
            validation: {
                allowed: true,
            },
        }))

        return {
            pipeline: {
                getPositions: vi.fn(async () => [firstPosition, secondPosition]),
                closeProviderPosition,
            } as unknown as ExecutionPipeline,
            closeProviderPosition,
            secondPosition,
        }
    }

    it("rejects ambiguous MT5 same-instrument closes without provider identity", async () => {
        const { pipeline, closeProviderPosition } = createMT5Pipeline()
        const venue = {
            getSymbolInfo: vi.fn(async () => ({ bid: 1.1009, ask: 1.1011 })),
        }
        const tool = createMT5ProposeCloseTool(pipeline, venue as never)

        const result = await tool.handler({
            instrument: "EURUSD",
            reason: "close risk",
        }) as { status: string; errorDetail?: { code?: string } }

        expect(result.status).toBe("rejected")
        expect(result.errorDetail).toMatchObject({
            code: "AMBIGUOUS_POSITION_IDENTITY",
        })
        expect(venue.getSymbolInfo).not.toHaveBeenCalled()
        expect(closeProviderPosition).not.toHaveBeenCalled()
    })

    it("closes the resolved MT5 provider position when providerPositionId identifies it", async () => {
        const { pipeline, closeProviderPosition, secondPosition } = createMT5Pipeline()
        const venue = {
            getSymbolInfo: vi.fn(async () => ({ bid: 1.1009, ask: 1.1011 })),
        }
        const tool = createMT5ProposeCloseTool(pipeline, venue as never)

        const result = await tool.handler({
            instrument: "EURUSD",
            providerPositionId: "333",
            reason: "close risk",
        }) as { status: string; providerPositionId?: string; positionSide?: string }

        expect(result.status).toBe("filled")
        expect(result).toMatchObject({
            providerPositionId: "333",
            positionSide: "short",
        })
        expect(venue.getSymbolInfo).toHaveBeenCalledWith("EURUSD")
        expect(closeProviderPosition).toHaveBeenCalledWith(
            secondPosition,
            "close risk",
            {
                estimatedPrice: 1.1011,
            }
        )
    })
})

describe("createOKXProposeCloseTool", () => {
    function createOKXPipeline() {
        const shortPosition = {
            instrument: "BTC-USDT-SWAP",
            providerPositionId: "short-pos",
            side: "short" as const,
            quantity: 0.2,
            entryPrice: 81000,
            currentPrice: 80000,
            metadata: {
                posId: "short-pos",
            },
        }
        const longPosition = {
            instrument: "BTC-USDT-SWAP",
            providerPositionId: "long-pos",
            side: "long" as const,
            quantity: 0.1,
            entryPrice: 79000,
            currentPrice: 80000,
            metadata: {
                posId: "long-pos",
            },
        }
        const closeProviderPosition = vi.fn(async () => ({
            result: {
                orderId: "vokc01closeorder",
                status: "filled" as const,
                filledQuantity: 0.2,
                fillPrice: 80000,
                timestamp: Date.now(),
            },
            validation: {
                allowed: true,
            },
        }))

        return {
            pipeline: {
                getPositions: vi.fn(async () => [longPosition, shortPosition]),
                closeProviderPosition,
            } as unknown as ExecutionPipeline,
            closeProviderPosition,
            shortPosition,
        }
    }

    it("rejects ambiguous OKX same-instrument closes without side or provider identity", async () => {
        const { pipeline, closeProviderPosition } = createOKXPipeline()
        const venue = {
            getCurrentMarkPrice: vi.fn(async () => 80000),
        }
        const tool = createOKXProposeCloseTool(pipeline, venue as never)

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            reason: "close risk",
        }) as { status: string; errorDetail?: { code?: string } }

        expect(result.status).toBe("rejected")
        expect(result.errorDetail).toMatchObject({
            code: "AMBIGUOUS_POSITION_IDENTITY",
        })
        expect(venue.getCurrentMarkPrice).not.toHaveBeenCalled()
        expect(closeProviderPosition).not.toHaveBeenCalled()
    })

    it("closes the resolved OKX provider position when positionSide identifies it", async () => {
        const { pipeline, closeProviderPosition, shortPosition } = createOKXPipeline()
        const venue = {
            getCurrentMarkPrice: vi.fn(async () => 80000),
        }
        const tool = createOKXProposeCloseTool(pipeline, venue as never)

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            positionSide: "short",
            reason: "close risk",
        }) as { status: string; providerPositionId?: string; providerPositionKey?: string; positionSide?: string }

        expect(result.status).toBe("filled")
        expect(result).toMatchObject({
            providerPositionId: "short-pos",
            providerPositionKey: "BTC-USDT-SWAP:short-pos",
            positionSide: "short",
        })
        expect(venue.getCurrentMarkPrice).toHaveBeenCalledWith("BTC-USDT-SWAP")
        expect(closeProviderPosition).toHaveBeenCalledWith(
            shortPosition,
            "close risk",
            {
                estimatedPrice: 80000,
            }
        )
    })
})
