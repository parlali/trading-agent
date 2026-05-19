import { describe, expect, it, vi } from "vitest"
import { createOKXProposeAdjustmentTool } from "./propose-adjustment-okx.ts"
import { classifyOKXProtectionFailure } from "./okx-order-helpers.ts"

function createPipeline(position: {
    stopLoss?: number
    takeProfit?: number
} = {}, closePosition?: ReturnType<typeof vi.fn>) {
    return {
        getPositions: vi.fn(async () => [{
            instrument: "BTC-USDT-SWAP",
            side: "long" as const,
            quantity: 0.1,
            entryPrice: 100,
            currentPrice: 105,
            ...position,
        }]),
        createExecutionOperationContext: vi.fn(async () => ({
            identity: {
                canonicalOrderId: "vokm01abcde23456",
                providerClientOrderId: "vokm01abcde23456",
                providerOrderAliases: [],
                submitAttemptId: "attempt",
                submitAttemptSequence: 1,
                commitOutcome: "accepted" as const,
                venue: "okx-swap",
                role: "modify" as const,
                sequence: 1,
            },
        })),
        closePosition: closePosition ?? vi.fn(async () => ({
            result: {
                orderId: "close-1",
                status: "filled",
                filledQuantity: 0.1,
                timestamp: Date.now(),
            },
            validation: { allowed: true },
        })),
    }
}

function createVenue(refreshed: {
    stopLoss?: number
    takeProfit?: number
} = {}) {
    return {
        normalizePrice: vi.fn(async (_instrument: string, price: number) => price),
        updateProtectionOrders: vi.fn(async () => ({
            cancelledOrderIds: ["algo:BTC-USDT-SWAP:old"],
            createdOrderIds: ["algo:BTC-USDT-SWAP:new"],
        })),
        getPositions: vi.fn(async () => [{
            instrument: "BTC-USDT-SWAP",
            side: "long" as const,
            quantity: 0.1,
            entryPrice: 100,
            currentPrice: 105,
            ...refreshed,
        }]),
    }
}

describe("createOKXProposeAdjustmentTool", () => {
    it("classifies bounded OKX protection update failures", () => {
        expect(classifyOKXProtectionFailure("No open OKX swap position found for BTC-USDT-SWAP")).toBe("position_not_found_yet")
        expect(classifyOKXProtectionFailure("/api/v5/trade/order-algo rejected sCode=51008")).toBe("provider_rejected")
        expect(classifyOKXProtectionFailure("invalid parameter: trigger price")).toBe("invalid_params")
        expect(classifyOKXProtectionFailure("algo order already exists conflict")).toBe("already_exists_conflict")
        expect(classifyOKXProtectionFailure("pending protection disappeared after acknowledgement")).toBe("unknown")
    })

    it("preserves an existing stop-loss for take-profit-only adjustments", async () => {
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 95, takeProfit: 118 })
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never)

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            takeProfit: 118,
            reason: "raise target",
        }) as { status: string }

        expect(result.status).toBe("updated")
        expect(venue.updateProtectionOrders).toHaveBeenCalledWith(expect.objectContaining({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 95,
            takeProfit: 118,
        }))
        expect(pipeline.closePosition).not.toHaveBeenCalled()
    })

    it("preserves an existing take-profit for stop-only adjustments", async () => {
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 97, takeProfit: 112 })
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never)

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 97,
            reason: "tighten stop",
        }) as { status: string }

        expect(result.status).toBe("updated")
        expect(venue.updateProtectionOrders).toHaveBeenCalledWith(expect.objectContaining({
            stopLoss: 97,
            takeProfit: 112,
        }))
        expect(pipeline.closePosition).not.toHaveBeenCalled()
    })

    it("updates full stop and take-profit protection", async () => {
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 96, takeProfit: 116 })
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never)

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 96,
            takeProfit: 116,
            reason: "refresh both",
        }) as { status: string }

        expect(result.status).toBe("updated")
        expect(venue.updateProtectionOrders).toHaveBeenCalledWith(expect.objectContaining({
            stopLoss: 96,
            takeProfit: 116,
        }))
    })

    it("fails closed when provider truth cannot prove the intended final protection state", async () => {
        const faultRecorder = vi.fn(async () => {})
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ takeProfit: 118 })
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
            onExecutionSafetyFault: faultRecorder,
        })

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            takeProfit: 118,
            reason: "raise target",
        }) as { status: string; error?: string }

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("existing stopLoss")
        expect(pipeline.closePosition).toHaveBeenCalledOnce()
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            instrument: "BTC-USDT-SWAP",
            category: "invalid_params",
            canonicalOrderId: "vokm01abcde23456",
            submitAttemptId: "attempt",
        }))
    })

    it("fails closed when provider truth refresh throws after protection update", async () => {
        const faultRecorder = vi.fn(async () => {})
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 97, takeProfit: 118 })
        venue.getPositions.mockRejectedValue(new Error("OKX positions read timed out"))
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
            onExecutionSafetyFault: faultRecorder,
        })

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 97,
            takeProfit: 118,
            reason: "replace both",
        }) as { status: string; error?: string; protectionFailureCategory?: string; flattened?: boolean }

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("Position was flattened to fail closed")
        expect(result.protectionFailureCategory).toBe("unknown")
        expect(result.flattened).toBe(true)
        expect(pipeline.closePosition).toHaveBeenCalledWith(
            "BTC-USDT-SWAP",
            "Protection verification failed after adjustment; flattening to fail closed",
            expect.objectContaining({
                metadata: expect.objectContaining({
                    executionSafetyCategory: "unknown",
                }),
            })
        )
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            category: "unknown",
            message: expect.stringContaining("provider truth read failed"),
            providerPayload: expect.stringContaining("OKX positions read timed out"),
        }))
    })

    it("fails closed and persists a fault when protection update rejects before create", async () => {
        const faultRecorder = vi.fn(async () => {})
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 95, takeProfit: 112 })
        venue.updateProtectionOrders.mockRejectedValue(new Error("invalid parameter before create"))
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
            onExecutionSafetyFault: faultRecorder,
        })

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 97,
            reason: "tighten stop",
        }) as { status: string; error?: string; protectionFailureCategory?: string; flattened?: boolean }

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("Position was flattened to fail closed")
        expect(result.protectionFailureCategory).toBe("invalid_params")
        expect(result.flattened).toBe(true)
        expect(pipeline.closePosition).toHaveBeenCalledWith(
            "BTC-USDT-SWAP",
            "Protection update failed; flattening to fail closed",
            expect.objectContaining({
                metadata: expect.objectContaining({
                    executionSafetyCategory: "invalid_params",
                }),
            })
        )
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            instrument: "BTC-USDT-SWAP",
            category: "invalid_params",
            message: "invalid parameter before create",
            canonicalOrderId: "vokm01abcde23456",
            providerClientOrderId: "vokm01abcde23456",
        }))
    })

    it("fails closed and persists a fault when protection update rejects after cancellation", async () => {
        const faultRecorder = vi.fn(async () => {})
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 95, takeProfit: 112 })
        venue.updateProtectionOrders.mockRejectedValue(new Error("cancelled old algo then /api/v5/trade/order-algo rejected sCode=51008"))
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
            onExecutionSafetyFault: faultRecorder,
        })

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 97,
            takeProfit: 118,
            reason: "replace both",
        }) as { status: string; protectionFailureCategory?: string; flattened?: boolean }

        expect(result.status).toBe("rejected")
        expect(result.protectionFailureCategory).toBe("provider_rejected")
        expect(result.flattened).toBe(true)
        expect(pipeline.closePosition).toHaveBeenCalledOnce()
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            category: "provider_rejected",
            message: "cancelled old algo then /api/v5/trade/order-algo rejected sCode=51008",
        }))
    })

    it("fails closed when protection create acknowledgement cannot be proven pending", async () => {
        const faultRecorder = vi.fn(async () => {})
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
        const venue = createVenue({ stopLoss: 95, takeProfit: 112 })
        venue.updateProtectionOrders.mockRejectedValue(new Error("OKX protection order placement did not appear in pending algo orders for BTC-USDT-SWAP (code: PROTECTION_NOT_PENDING)"))
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
            onExecutionSafetyFault: faultRecorder,
        })

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            takeProfit: 118,
            reason: "raise target",
        }) as { status: string; protectionFailureCategory?: string; flattened?: boolean }

        expect(result.status).toBe("rejected")
        expect(result.protectionFailureCategory).toBe("unknown")
        expect(result.flattened).toBe(true)
        expect(pipeline.closePosition).toHaveBeenCalledOnce()
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            category: "unknown",
            providerPayload: expect.stringContaining("PROTECTION_NOT_PENDING"),
        }))
    })

    it("persists residual exposure evidence when fail-closed flattening fails", async () => {
        const faultRecorder = vi.fn(async () => {})
        const closePosition = vi.fn(async () => {
            throw new Error("close position rejected")
        })
        const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 }, closePosition)
        const venue = createVenue({ stopLoss: 95, takeProfit: 112 })
        venue.updateProtectionOrders.mockRejectedValue(new Error("/api/v5/trade/order-algo rejected sCode=51008"))
        const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
            onExecutionSafetyFault: faultRecorder,
        })

        const result = await tool.handler({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 97,
            reason: "tighten stop",
        }) as { status: string; error?: string; protectionFailureCategory?: string; flattened?: boolean }

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("flatten_failed=close position rejected")
        expect(result.protectionFailureCategory).toBe("provider_rejected")
        expect(result.flattened).toBe(false)
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            category: "provider_rejected",
            message: expect.stringContaining("flatten_failed=close position rejected"),
            providerPayload: expect.stringContaining("close position rejected"),
        }))
    })
})
