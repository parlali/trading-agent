import { describe, expect, it, vi } from "vitest"
import type { OKXPolicy } from "@valiq-trading/core"
import { prepareOKXOrder } from "./okx-order-helpers"

const policy: OKXPolicy = {
    dryRun: false,
    model: "gpt-5.4",
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

describe("prepareOKXOrder protection fail-closed", () => {
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
})
