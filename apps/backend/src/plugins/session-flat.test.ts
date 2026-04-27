import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "@valiq-trading/core"
import { OKXPlugin } from "./okx"
import { MT5Plugin } from "./mt5.ts"

const logger = createLogger({ minLevel: "fatal" })

function createPolicy(app: "okx-swap" | "mt5") {
    return app === "okx-swap"
        ? {
            model: "openai/gpt-5.5",
            allowedInstruments: ["BTC-USDT-SWAP"],
            maxLeverage: 3,
            maxRiskPercent: 1,
            tradingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
            fundingRateThreshold: 0.003,
            requireTakeProfit: true,
            safety: {
                maxDrawdownDay: 3,
                maxDrawdownWeek: 10,
                cooldownMinutesAfterDayBreach: 720,
                cooldownMinutesAfterWeekBreach: 1440,
                strategyTimezone: "UTC",
                sessionFlat: { enabled: true, closeBufferMinutes: 15, timezone: "UTC" },
                account: { allocationPercent: 100 },
                expectedExternalInstruments: [],
            },
            dryRun: false,
        }
        : {
            model: "openai/gpt-5.5",
            maxRiskPercent: 1,
            minRiskReward: 1,
            tradingHours: { start: "07:00", end: "21:00", timezone: "UTC" },
            safety: {
                maxDrawdownDay: 3,
                maxDrawdownWeek: 10,
                cooldownMinutesAfterDayBreach: 720,
                cooldownMinutesAfterWeekBreach: 1440,
                strategyTimezone: "UTC",
                sessionFlat: { enabled: true, closeBufferMinutes: 15, timezone: "UTC" },
                account: { allocationPercent: 100 },
                expectedExternalInstruments: [],
            },
            dryRun: false,
            allowMultiplePendingEntryOrdersPerInstrument: false,
            allowOverlappingExposure: false,
            marketRegionsByInstrument: {
                XAUUSD: ["US"],
            },
        }
}

describe("session-flat ownership scope", () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it("OKX closes and cancels only the active strategy-owned exposure", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-04-27T23:50:00.000Z"))

        const closeProviderPosition = vi.fn(async () => ({
            orderId: "close-btc",
            status: "filled",
            filledQuantity: 1,
            timestamp: Date.now(),
        }))
        const cancelOrder = vi.fn(async () => ({
            orderId: "order-btc",
            status: "cancelled",
            filledQuantity: 0,
            timestamp: Date.now(),
        }))

        const result = await new OKXPlugin().preRunHooks({
            venue: {
                closeProviderPosition,
                cancelOrder,
            } as never,
            policy: createPolicy("okx-swap"),
            strategyId: "btc-strategy",
            ownedInstruments: new Set(["BTC-USDT-SWAP"]),
            ownedPositions: [
                {
                    instrument: "BTC-USDT-SWAP",
                    side: "long",
                    quantity: 0.1,
                    entryPrice: 80_000,
                },
            ],
            ownedWorkingOrders: [
                {
                    orderId: "order-btc",
                    instrument: "BTC-USDT-SWAP",
                    status: "pending",
                    quantity: 0.1,
                    filledQuantity: 0,
                    remainingQuantity: 0.1,
                    submittedAt: Date.now(),
                    updatedAt: Date.now(),
                    cancelAt: Date.now() + 60 * 60 * 1000,
                },
            ],
            strategyAccountState: {
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
            },
            logger,
            createAlert: vi.fn(async () => {}),
        })

        expect(result).toMatchObject({
            skip: true,
            providerStateChanged: true,
        })
        expect(closeProviderPosition).toHaveBeenCalledTimes(1)
        expect(closeProviderPosition).toHaveBeenCalledWith(expect.objectContaining({
            instrument: "BTC-USDT-SWAP",
        }))
        expect(cancelOrder).toHaveBeenCalledTimes(1)
        expect(cancelOrder).toHaveBeenCalledWith("order-btc")
    })

    it("MT5 closes by provider position and does not use account-wide bulk close", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-04-27T20:50:00.000Z"))

        const closeProviderPosition = vi.fn(async () => ({
            orderId: "1600791764",
            status: "filled",
            filledQuantity: 0.01,
            timestamp: Date.now(),
        }))
        const closeAllPositions = vi.fn()

        const result = await new MT5Plugin().preRunHooks({
            venue: {
                closeProviderPosition,
                closeAllPositions,
                cancelOrder: vi.fn(),
                getAccountState: vi.fn(async () => ({
                    balance: 10_000,
                    equity: 10_000,
                    buyingPower: 10_000,
                    marginUsed: 0,
                    marginAvailable: 10_000,
                    openPnl: 0,
                    dayPnl: 0,
                })),
            } as never,
            policy: createPolicy("mt5"),
            strategyId: "gold-strategy",
            ownedInstruments: new Set(["XAUUSD"]),
            ownedPositions: [
                {
                    instrument: "XAUUSD",
                    providerPositionId: "1600791764",
                    side: "long",
                    quantity: 0.01,
                    entryPrice: 3330,
                },
            ],
            ownedWorkingOrders: [],
            strategyAccountState: {
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
            },
            logger,
            createAlert: vi.fn(async () => {}),
        })

        expect(result).toMatchObject({
            skip: true,
            providerStateChanged: true,
        })
        expect(closeProviderPosition).toHaveBeenCalledWith(expect.objectContaining({
            providerPositionId: "1600791764",
        }))
        expect(closeAllPositions).not.toHaveBeenCalled()
    })
})
