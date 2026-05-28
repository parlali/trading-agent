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

    it("updates OKX protection while preserving unchanged stop-loss or take-profit legs", async () => {
        const cases = [
            {
                name: "take-profit only",
                refreshed: { stopLoss: 95, takeProfit: 118 },
                input: {
                    instrument: "BTC-USDT-SWAP",
                    takeProfit: 118,
                    reason: "raise target",
                },
                expected: {
                    instrument: "BTC-USDT-SWAP",
                    stopLoss: 95,
                    takeProfit: 118,
                },
            },
            {
                name: "stop only",
                refreshed: { stopLoss: 97, takeProfit: 112 },
                input: {
                    instrument: "BTC-USDT-SWAP",
                    stopLoss: 97,
                    reason: "tighten stop",
                },
                expected: {
                    stopLoss: 97,
                    takeProfit: 112,
                },
            },
            {
                name: "full protection",
                refreshed: { stopLoss: 96, takeProfit: 116 },
                input: {
                    instrument: "BTC-USDT-SWAP",
                    stopLoss: 96,
                    takeProfit: 116,
                    reason: "refresh both",
                },
                expected: {
                    stopLoss: 96,
                    takeProfit: 116,
                },
            },
        ]

        for (const testCase of cases) {
            const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
            const venue = createVenue(testCase.refreshed)
            const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never)

            const result = await tool.handler(testCase.input) as { status: string }

            expect(result.status, testCase.name).toBe("updated")
            expect(venue.updateProtectionOrders, testCase.name).toHaveBeenCalledWith(expect.objectContaining(testCase.expected))
            expect(pipeline.closePosition, testCase.name).not.toHaveBeenCalled()
        }
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

    it("fails closed and persists a fault for bounded protection-update rejection stages", async () => {
        const cases = [
            {
                name: "before create",
                error: "invalid parameter before create",
                input: {
                    instrument: "BTC-USDT-SWAP",
                    stopLoss: 97,
                    reason: "tighten stop",
                },
                category: "invalid_params",
                fault: {
                    instrument: "BTC-USDT-SWAP",
                    category: "invalid_params",
                    message: "invalid parameter before create",
                    canonicalOrderId: "vokm01abcde23456",
                    providerClientOrderId: "vokm01abcde23456",
                },
            },
            {
                name: "after cancellation",
                error: "cancelled old algo then /api/v5/trade/order-algo rejected sCode=51008",
                input: {
                    instrument: "BTC-USDT-SWAP",
                    stopLoss: 97,
                    takeProfit: 118,
                    reason: "replace both",
                },
                category: "provider_rejected",
                fault: {
                    category: "provider_rejected",
                    message: "cancelled old algo then /api/v5/trade/order-algo rejected sCode=51008",
                },
            },
            {
                name: "unproven pending acknowledgement",
                error: "OKX protection order placement did not appear in pending algo orders for BTC-USDT-SWAP (code: PROTECTION_NOT_PENDING)",
                input: {
                    instrument: "BTC-USDT-SWAP",
                    takeProfit: 118,
                    reason: "raise target",
                },
                category: "unknown",
                fault: {
                    category: "unknown",
                    providerPayload: expect.stringContaining("PROTECTION_NOT_PENDING"),
                },
            },
        ]

        for (const testCase of cases) {
            const faultRecorder = vi.fn(async () => {})
            const pipeline = createPipeline({ stopLoss: 95, takeProfit: 112 })
            const venue = createVenue({ stopLoss: 95, takeProfit: 112 })
            venue.updateProtectionOrders.mockRejectedValue(new Error(testCase.error))
            const tool = createOKXProposeAdjustmentTool(pipeline as never, venue as never, {
                onExecutionSafetyFault: faultRecorder,
            })

            const result = await tool.handler(testCase.input) as { status: string; error?: string; protectionFailureCategory?: string; flattened?: boolean }

            expect(result.status, testCase.name).toBe("rejected")
            expect(result.error, testCase.name).toContain("Position was flattened to fail closed")
            expect(result.protectionFailureCategory, testCase.name).toBe(testCase.category)
            expect(result.flattened, testCase.name).toBe(true)
            expect(pipeline.closePosition, testCase.name).toHaveBeenCalledWith(
                "BTC-USDT-SWAP",
                "Protection update failed; flattening to fail closed",
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        executionSafetyCategory: testCase.category,
                    }),
                })
            )
            expect(faultRecorder, testCase.name).toHaveBeenCalledWith(expect.objectContaining(testCase.fault))
        }
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
