import { describe, expect, it, vi } from "vitest"
import type { OKXPolicy } from "@valiq-trading/core"
import { prepareOKXOrder } from "./okx-order-helpers"

const policy: OKXPolicy = {
    dryRun: false,
    llm: {
        provider: "openrouter",
        model: "gpt-5.4",
    },
    safety: {
        maxDrawdownDay: undefined,
        maxDrawdownWeek: undefined,
        cooldownMinutesAfterDayBreach: 12 * 60,
        cooldownMinutesAfterWeekBreach: 24 * 60,
        strategyTimezone: "UTC",
        sessionFlat: {
            enabled: false,
            closeBufferMinutes: 15,
            timezone: "UTC",
        },
        account: {
            allocationPercent: 100,
        },
        expectedExternalInstruments: [],
        pendingEntryTtlMinutes: 30,
    },
    allowedInstruments: ["BTC-USDT-SWAP"],
    maxLeverage: 3,
    maxRiskPercent: 1,
    tradingHours: {
        start: "00:00",
        end: "23:59",
        timezone: "UTC",
    },
    fundingRateThreshold: 1,
    requireTakeProfit: true,
}

function createPipelineMock() {
    return {
        getAccountState: vi.fn().mockResolvedValue({
            balance: 10_000,
            equity: 10_000,
            buyingPower: 10_000,
            marginUsed: 0,
            marginAvailable: 10_000,
            openPnl: 0,
            dayPnl: 0,
        }),
        getPositions: vi.fn().mockResolvedValue([]),
        executeIntent: vi.fn().mockResolvedValue({
            validation: {
                allowed: true,
            },
            result: {
                orderId: "entry-1",
                status: "filled",
                filledQuantity: 1,
                fillPrice: 100,
                timestamp: Date.now(),
            },
        }),
        closePosition: vi.fn().mockResolvedValue({
            validation: {
                allowed: true,
            },
            result: {
                orderId: "close-1",
                status: "filled",
                filledQuantity: 1,
                fillPrice: 99,
                timestamp: Date.now(),
            },
        }),
        createExecutionOperationContext: vi.fn().mockResolvedValue({
            identity: {
                canonicalOrderId: "vokm01protect01",
                providerClientOrderId: "vokm01protect01",
                providerOrderAliases: [],
                submitAttemptId: "attempt-protect",
                submitAttemptSequence: 1,
                commitOutcome: "accepted",
                venue: "okx-swap",
                role: "modify",
                sequence: 1,
            },
        }),
    }
}

function createVenueMock() {
    return {
        getCurrentMarkPrice: vi.fn().mockResolvedValue(100),
        getCurrentFundingRate: vi.fn().mockResolvedValue(0.001),
        normalizeQuantity: vi.fn().mockResolvedValue({
            contracts: 1,
            baseQuantity: 1,
        }),
        normalizePrice: vi.fn(async (_instrument: string, price: number) => price),
        updateProtectionOrders: vi.fn(),
        getWorkingOrders: vi.fn().mockResolvedValue([]),
        getPositions: vi.fn().mockResolvedValue([
            {
                instrument: "BTC-USDT-SWAP",
                side: "long",
                quantity: 1,
                entryPrice: 100,
                currentPrice: 100,
                stopLoss: undefined,
                takeProfit: undefined,
            },
        ]),
    }
}

describe("prepareOKXOrder exposure guards", () => {
    it("sizes entries from stop risk plus estimated round-trip fees", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()

        await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "limit",
                limitPrice: 100,
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry"
        )

        expect(venue.normalizeQuantity).toHaveBeenCalledWith("BTC-USDT-SWAP", 100 / 5.5)
        expect(pipeline.executeIntent).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    estimatedRoundTripFees: 0.5,
                    riskAmount: 5.5,
                    riskPercent: 0.055,
                }),
            }),
            expect.anything(),
            expect.anything(),
            { action: "entry" }
        )
    })

    it("blocks new entries when the same strategy already has a live position", async () => {
        const pipeline = createPipelineMock()
        pipeline.getPositions.mockResolvedValue([
            {
                instrument: "BTC-USDT-SWAP",
                side: "long",
                quantity: 1,
                entryPrice: 100,
                currentPrice: 100,
            },
        ])
        const venue = createVenueMock()

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "limit",
                limitPrice: 100,
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry"
        )

        expect(result.riskValidation.allowed).toBe(false)
        expect(result.error).toContain("already has a live long position")
        expect(pipeline.executeIntent).not.toHaveBeenCalled()
    })

    it("blocks new entries when a non-protection working order is live", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()
        venue.getWorkingOrders.mockResolvedValue([
            {
                orderId: "order:BTC-USDT-SWAP:entry-1",
                instrument: "BTC-USDT-SWAP",
                status: "pending",
                quantity: 1,
                filledQuantity: 0,
                remainingQuantity: 1,
                submittedAt: Date.now(),
                updatedAt: Date.now(),
                side: "sell",
                limitPrice: 101,
                metadata: {
                    orderType: "limit",
                },
            },
        ])

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "limit",
                limitPrice: 100,
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry"
        )

        expect(result.riskValidation.allowed).toBe(false)
        expect(result.error).toContain("live non-protection working order")
        expect(pipeline.executeIntent).not.toHaveBeenCalled()
    })

    it("stops downstream execution when aborted during provider preparation", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()
        const controller = new AbortController()
        venue.getCurrentMarkPrice.mockImplementation(async () => {
            controller.abort()
            return 100
        })

        await expect(prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "limit",
                limitPrice: 100,
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry",
            undefined,
            controller.signal
        )).rejects.toMatchObject({
            name: "AbortError",
            message: "Tool execution cancelled",
        })
        expect(pipeline.executeIntent).not.toHaveBeenCalled()
    })
})

describe("prepareOKXOrder protection fail-closed", () => {
    it("accepts provider-verified attached protection without replacing it", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()
        venue.getPositions.mockResolvedValue([
            {
                instrument: "BTC-USDT-SWAP",
                side: "long",
                quantity: 1,
                entryPrice: 100,
                currentPrice: 100,
                stopLoss: 95,
                takeProfit: 110,
            },
        ])
        Object.assign(venue, {
            getWorkingOrders: vi.fn().mockResolvedValue([
                {
                    orderId: "algo:BTC-USDT-SWAP:attached-1",
                    instrument: "BTC-USDT-SWAP",
                    status: "pending",
                    quantity: 1,
                    filledQuantity: 0,
                    remainingQuantity: 1,
                    submittedAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        kind: "protection",
                    },
                },
            ]),
        })
        const resolveFaults = vi.fn(async () => {})

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "market",
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry",
            {
                resolveFaults,
            }
        )

        expect(result.protectionOrders).toEqual({
            cancelledOrderIds: [],
            createdOrderIds: ["algo:BTC-USDT-SWAP:attached-1"],
        })
        expect(venue.updateProtectionOrders).not.toHaveBeenCalled()
        expect(pipeline.closePosition).not.toHaveBeenCalled()
        expect(resolveFaults).toHaveBeenCalledWith({
            instrument: "BTC-USDT-SWAP",
            resolutionNote: "Attached OKX protection verified from provider truth after entry fill",
        })
    })

    it("flattens and records provider-rejected /api/v5/trade/order-algo protection failures", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()
        venue.updateProtectionOrders.mockRejectedValue(new Error("/api/v5/trade/order-algo rejected sCode=51008"))

        const recordFault = vi.fn(async () => {})

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "market",
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry",
            {
                recordFault,
            }
        )

        expect(result.protectionOrders?.category).toBe("provider_rejected")
        expect(result.protectionOrders?.flattened).toBe(true)

        expect(pipeline.closePosition).toHaveBeenCalledTimes(1)
        expect(pipeline.closePosition).toHaveBeenCalledWith(
            "BTC-USDT-SWAP",
            "Protection attachment failed; flattening to fail closed",
            expect.objectContaining({
                metadata: expect.objectContaining({
                    forcedExit: true,
                    executionSafetyCategory: "provider_rejected",
                }),
            })
        )

        expect(recordFault).toHaveBeenCalledWith(expect.objectContaining({
            instrument: "BTC-USDT-SWAP",
            category: "provider_rejected",
        }))
    })

    it("passes canonical identity to standalone entry protection repair", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()
        const unprotectedPosition = {
            instrument: "BTC-USDT-SWAP",
            side: "long",
            quantity: 1,
            entryPrice: 100,
            currentPrice: 100,
            stopLoss: undefined,
            takeProfit: undefined,
        }
        const protectedPosition = {
            ...unprotectedPosition,
            stopLoss: 95,
            takeProfit: 110,
        }
        venue.getPositions
            .mockResolvedValueOnce([unprotectedPosition])
            .mockResolvedValueOnce([unprotectedPosition])
            .mockResolvedValueOnce([unprotectedPosition])
            .mockResolvedValue([protectedPosition])
        venue.updateProtectionOrders.mockResolvedValue({
            cancelledOrderIds: [],
            createdOrderIds: ["algo:BTC-USDT-SWAP:repair-1"],
        })

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "market",
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry"
        )

        expect(venue.updateProtectionOrders).toHaveBeenCalledWith(expect.objectContaining({
            identity: expect.objectContaining({
                providerClientOrderId: "vokm01protect01",
            }),
        }))
        expect(result.protectionOrders).toEqual({
            cancelledOrderIds: [],
            createdOrderIds: ["algo:BTC-USDT-SWAP:repair-1"],
        })
        expect(pipeline.closePosition).not.toHaveBeenCalled()
    })

    it("flattens when initial protection provider-truth verification cannot be read", async () => {
        const pipeline = createPipelineMock()
        const venue = createVenueMock()
        venue.getPositions.mockRejectedValue(new Error("provider truth read failed"))
        const recordFault = vi.fn(async () => {})

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "market",
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry",
            {
                recordFault,
            }
        )

        expect(venue.updateProtectionOrders).not.toHaveBeenCalled()
        expect(result.protectionOrders?.flattened).toBe(true)
        expect(result.protectionOrders?.error).toContain("provider truth read failed")
        expect(pipeline.closePosition).toHaveBeenCalledWith(
            "BTC-USDT-SWAP",
            "Protection verification failed after entry fill; flattening to fail closed",
            expect.objectContaining({
                metadata: expect.objectContaining({
                    forcedExit: true,
                }),
            })
        )
        expect(recordFault).toHaveBeenCalledWith(expect.objectContaining({
            canonicalOrderId: "vokm01protect01",
            providerClientOrderId: "vokm01protect01",
            submitAttemptId: "attempt-protect",
        }))
    })

    it("records a critical fault when flatten also fails", async () => {
        const pipeline = createPipelineMock()
        pipeline.closePosition.mockRejectedValue(new Error("close position rejected"))

        const venue = createVenueMock()
        venue.updateProtectionOrders.mockRejectedValue(new Error("/api/v5/trade/order-algo invalid parameter"))

        const recordFault = vi.fn(async () => {})

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "market",
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry",
            {
                recordFault,
            }
        )

        expect(result.protectionOrders?.category).toBe("invalid_params")
        expect(result.protectionOrders?.flattened).toBe(false)
        expect(result.protectionOrders?.error).toContain("flatten_failed")
        expect(recordFault).toHaveBeenCalledWith(expect.objectContaining({
            category: "invalid_params",
            message: expect.stringContaining("flatten_failed"),
        }))
    })

    it("records residual exposure when fail-closed flatten only partially fills", async () => {
        const pipeline = createPipelineMock()
        pipeline.closePosition.mockResolvedValue({
            validation: {
                allowed: true,
            },
            result: {
                orderId: "close-1",
                status: "partially_filled",
                filledQuantity: 0.4,
                fillPrice: 99,
                timestamp: Date.now(),
            },
        })

        const venue = createVenueMock()
        venue.updateProtectionOrders.mockRejectedValue(new Error("/api/v5/trade/order-algo rejected sCode=51008"))

        const recordFault = vi.fn(async () => {})

        const result = await prepareOKXOrder(
            {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                leverage: 2,
                orderType: "market",
                timeInForce: "gtc",
                stopLoss: 95,
                takeProfit: 110,
                reason: "test",
            },
            pipeline as never,
            venue as never,
            policy,
            "entry",
            {
                recordFault,
            }
        )

        expect(result.protectionOrders?.category).toBe("provider_rejected")
        expect(result.protectionOrders?.flattened).toBe(false)
        expect(result.protectionOrders?.error).toContain("flatten_failed=Flatten did not prove flat position: partially_filled")
        expect(recordFault).toHaveBeenCalledWith(expect.objectContaining({
            category: "provider_rejected",
            message: expect.stringContaining("partially_filled"),
        }))
    })
})
