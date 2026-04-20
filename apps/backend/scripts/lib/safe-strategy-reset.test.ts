import { afterEach, describe, expect, it, vi } from "vitest"
import type {
    DeleteStrategyResult,
    Id,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"
import { AlpacaPlugin } from "../../src/plugins/alpaca"
import { OKXPlugin } from "../../src/plugins/okx"
import {
    isDryRunStrategy,
    detectMarketClosedResetBlock,
    isMarketClosedExecutionFailure,
    reconcileAndVerifyReset,
    resetStrategySafely,
} from "./safe-strategy-reset.ts"

function createDeleteResult(): DeleteStrategyResult {
    return {
        runs: 0,
        agentLogs: 0,
        tradeEvents: 0,
        orders: 0,
        orderTransitions: 0,
        positions: 0,
        instrumentClaims: 0,
        positionSyncs: 0,
        strategyRiskStates: 0,
        executionSafetyFaults: 0,
        providerPositions: 0,
        providerWorkingOrders: 0,
        providerSyncStates: 0,
        accountSnapshots: 0,
        appHeartbeats: 0,
        manualRunRequests: 0,
        alerts: 0,
    }
}

function createStrategy(
    app: StoredStrategy["app"]
): StoredStrategy {
    const policy = app === "okx-swap"
        ? {
            dryRun: false,
            model: "openai/gpt-5.4",
            allowedInstruments: ["BTC-USDT-SWAP"],
            maxLeverage: 2,
            maxRiskPercent: 1,
            tradingHours: {
                start: "00:00",
                end: "23:59",
                timezone: "UTC",
            },
            safety: {
                maxDrawdownDay: 3,
                maxDrawdownWeek: 10,
                cooldownMinutesAfterDayBreach: 12 * 60,
                cooldownMinutesAfterWeekBreach: 24 * 60,
                strategyTimezone: "UTC",
                sessionFlat: {
                    enabled: true,
                    closeBufferMinutes: 15,
                    timezone: "UTC",
                },
                expectedExternalInstruments: [],
            },
            fundingRateThreshold: 0.003,
            requireTakeProfit: false,
        }
        : app === "alpaca-options"
            ? {
                dryRun: false,
                model: "openai/gpt-5.4",
                maxLossPerPlay: 150,
            }
        : {
            dryRun: false,
            model: "openai/gpt-5.4",
            maxRiskPercent: 1,
            minRiskReward: 1,
            tradingHours: {
                start: "00:00",
                end: "23:59",
                timezone: "UTC",
            },
            safety: {
                maxDrawdownDay: 3,
                maxDrawdownWeek: 10,
                cooldownMinutesAfterDayBreach: 12 * 60,
                cooldownMinutesAfterWeekBreach: 24 * 60,
                strategyTimezone: "UTC",
                sessionFlat: {
                    enabled: true,
                    closeBufferMinutes: 15,
                    timezone: "UTC",
                },
                expectedExternalInstruments: [],
            },
            allowMultiplePendingEntryOrdersPerInstrument: false,
            allowOverlappingExposure: false,
        }

    return {
        _id: "strategy-1" as Id<"strategies">,
        _creationTime: 0,
        app,
        name: `${app} strategy`,
        enabled: true,
        schedule: "0 * * * *",
        policy,
        context: "test",
    }
}

describe("resetStrategySafely", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("supports okx strategies in the safe reset flow", async () => {
        const strategy = createStrategy("okx-swap")
        const deleteResult = createDeleteResult()
        const venue = {
            getAccountState: vi.fn().mockResolvedValue({
                balance: 1000,
                equity: 1000,
                buyingPower: 1000,
                marginUsed: 0,
                marginAvailable: 1000,
                openPnl: 0,
                dayPnl: 0,
            }),
            getPositions: vi.fn().mockResolvedValue([]),
            getWorkingOrders: vi.fn().mockResolvedValue([]),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            submitOrder: vi.fn(),
            getOrderStatus: vi.fn(),
        }

        vi.spyOn(OKXPlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(OKXPlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getPortfolioPositions: vi.fn().mockResolvedValue([]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([]),
            getPortfolioFreshness: vi.fn().mockResolvedValue([{
                app: "okx-swap",
                accountScope: "single-account-per-venue",
                lastSyncedAt: Date.now(),
                lastVerifiedAt: Date.now(),
                providerStatus: "healthy",
                stale: false,
                driftDetected: false,
                positionCount: 0,
                pendingOrderCount: 0,
            }]),
            getActiveRun: vi.fn().mockResolvedValue(null),
            disableStrategy: vi.fn().mockResolvedValue(undefined),
            resolveSecrets: vi.fn().mockResolvedValue({}),
            reconcileProviderPortfolio: vi.fn().mockResolvedValue(undefined),
            deleteStrategy: vi.fn().mockResolvedValue(deleteResult),
        } as unknown as TradingBackendClient

        const result = await resetStrategySafely(client, strategy._id)

        expect(client.disableStrategy).toHaveBeenCalledWith(strategy._id)
        expect(client.resolveSecrets).toHaveBeenCalledWith([])
        expect(client.deleteStrategy).toHaveBeenCalledWith(strategy._id)
        expect(result.deleted).toEqual(deleteResult)
    })

    it("does not disable a strategy before confirming there is no active run", async () => {
        const strategy = createStrategy("mt5")
        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getPortfolioPositions: vi.fn().mockResolvedValue([]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([]),
            getPortfolioFreshness: vi.fn().mockResolvedValue([]),
            getActiveRun: vi.fn().mockResolvedValue({
                _id: "run-1",
            }),
            disableStrategy: vi.fn(),
        } as unknown as TradingBackendClient

        await expect(
            resetStrategySafely(client, strategy._id)
        ).rejects.toThrow("Cannot reset a strategy with an active run")

        expect(client.disableStrategy).not.toHaveBeenCalled()
    })

    it("retries reset verification until provider exposure clears", async () => {
        const setTimeoutSpy = stubImmediateTimeout()

        const strategy = createStrategy("okx-swap")
        const deleteResult = createDeleteResult()
        const venue = {
            getAccountState: vi.fn().mockResolvedValue({
                balance: 1000,
                equity: 1000,
                buyingPower: 1000,
                marginUsed: 0,
                marginAvailable: 1000,
                openPnl: 0,
                dayPnl: 0,
            }),
            getPositions: vi.fn().mockResolvedValue([]),
            getWorkingOrders: vi.fn().mockResolvedValue([]),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            submitOrder: vi.fn(),
            getOrderStatus: vi.fn(),
        }

        vi.spyOn(OKXPlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(OKXPlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getPortfolioPositions: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ instrument: "BTC-USDT-SWAP" }])
                .mockResolvedValueOnce([]),
            getPortfolioPendingOrders: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]),
            getPortfolioFreshness: vi.fn()
                .mockResolvedValueOnce([{
                    app: "okx-swap",
                    accountScope: "single-account-per-venue",
                    lastSyncedAt: Date.now(),
                    lastVerifiedAt: Date.now(),
                    providerStatus: "healthy",
                    stale: false,
                    driftDetected: false,
                    positionCount: 0,
                    pendingOrderCount: 0,
                }])
                .mockResolvedValueOnce([{
                    app: "okx-swap",
                    accountScope: "single-account-per-venue",
                    lastSyncedAt: Date.now(),
                    lastVerifiedAt: Date.now(),
                    providerStatus: "healthy",
                    stale: false,
                    driftDetected: false,
                    positionCount: 1,
                    pendingOrderCount: 0,
                }])
                .mockResolvedValueOnce([{
                    app: "okx-swap",
                    accountScope: "single-account-per-venue",
                    lastSyncedAt: Date.now(),
                    lastVerifiedAt: Date.now(),
                    providerStatus: "healthy",
                    stale: false,
                    driftDetected: false,
                    positionCount: 0,
                    pendingOrderCount: 0,
                }]),
            getActiveRun: vi.fn().mockResolvedValue(null),
            disableStrategy: vi.fn().mockResolvedValue(undefined),
            resolveSecrets: vi.fn().mockResolvedValue({}),
            reconcileProviderPortfolio: vi.fn().mockResolvedValue(undefined),
            deleteStrategy: vi.fn().mockResolvedValue(deleteResult),
        } as unknown as TradingBackendClient

        const resetPromise = resetStrategySafely(client, strategy._id)

        await expect(resetPromise).resolves.toMatchObject({
            deleted: deleteResult,
        })

        expect(client.reconcileProviderPortfolio).toHaveBeenCalledTimes(2)
        setTimeoutSpy.mockRestore()
    })

    it("allows destructive verification when exposure is flat but drift state remains degraded", async () => {
        const strategy = createStrategy("okx-swap")
        const venue = {
            getAccountState: vi.fn().mockResolvedValue({
                balance: 1000,
                equity: 1000,
                buyingPower: 1000,
                marginUsed: 0,
                marginAvailable: 1000,
                openPnl: 0,
                dayPnl: 0,
            }),
            getPositions: vi.fn().mockResolvedValue([]),
            getWorkingOrders: vi.fn().mockResolvedValue([]),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            submitOrder: vi.fn(),
            getOrderStatus: vi.fn(),
        }

        vi.spyOn(OKXPlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(OKXPlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            resolveSecrets: vi.fn().mockResolvedValue({}),
            reconcileProviderPortfolio: vi.fn().mockResolvedValue(undefined),
            getPortfolioFreshness: vi.fn().mockResolvedValue([{
                app: "okx-swap",
                accountScope: "single-account-per-venue",
                lastSyncedAt: Date.now(),
                lastVerifiedAt: Date.now(),
                providerStatus: "degraded",
                stale: false,
                driftDetected: true,
                positionCount: 0,
                pendingOrderCount: 0,
            }]),
            getPortfolioPositions: vi.fn().mockResolvedValue([]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([]),
        } as unknown as TradingBackendClient

        await expect(
            import("./safe-strategy-reset.ts").then(async ({ reconcileAndVerifyReset }) =>
                await reconcileAndVerifyReset(client, strategy, undefined, {
                    requireHealthyState: false,
                })
            )
        ).resolves.toBeUndefined()
    })

    it("treats dry-run strategies as Convex-only resets", async () => {
        const strategy = createStrategy("polymarket")
        strategy.policy.dryRun = true

        expect(isDryRunStrategy(strategy)).toBe(true)

        const deleteResult = createDeleteResult()
        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getPortfolioPositions: vi.fn().mockResolvedValue([{
                instrument: "token-1",
            }]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([]),
            getPortfolioFreshness: vi.fn().mockResolvedValue([{
                app: "polymarket",
                accountScope: "single-account-per-venue",
                lastSyncedAt: Date.now(),
                lastVerifiedAt: Date.now(),
                providerStatus: "degraded",
                stale: false,
                driftDetected: true,
                positionCount: 9,
                pendingOrderCount: 0,
            }]),
            getActiveRun: vi.fn().mockResolvedValue(null),
            disableStrategy: vi.fn().mockResolvedValue(undefined),
            deleteStrategy: vi.fn().mockResolvedValue(deleteResult),
        } as unknown as TradingBackendClient

        const result = await resetStrategySafely(client, strategy._id)

        expect(client.disableStrategy).toHaveBeenCalledWith(strategy._id)
        expect(client.deleteStrategy).toHaveBeenCalledWith(strategy._id)
        expect(result.cancelledOrders).toBe(0)
        expect(result.closedPositions).toBe(0)
    })

    it("includes remaining exposure identifiers in verification failures", async () => {
        const setTimeoutSpy = stubImmediateTimeout()

        const strategy = createStrategy("alpaca-options")
        const venue = {
            getAccountState: vi.fn().mockResolvedValue({
                balance: 1000,
                equity: 1000,
                buyingPower: 1000,
                marginUsed: 0,
                marginAvailable: 1000,
                openPnl: 0,
                dayPnl: 0,
            }),
            getPositions: vi.fn().mockResolvedValue([]),
            getWorkingOrders: vi.fn().mockResolvedValue([]),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            submitOrder: vi.fn(),
            getOrderStatus: vi.fn(),
        }

        vi.spyOn(AlpacaPlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(AlpacaPlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            resolveSecrets: vi.fn().mockResolvedValue({}),
            reconcileProviderPortfolio: vi.fn().mockResolvedValue(undefined),
            getPortfolioFreshness: vi.fn().mockResolvedValue([{
                app: "alpaca-options",
                accountScope: "single-account-per-venue",
                lastSyncedAt: Date.now(),
                lastVerifiedAt: Date.now(),
                providerStatus: "healthy",
                stale: false,
                driftDetected: false,
                positionCount: 2,
                pendingOrderCount: 1,
            }]),
            getPortfolioPositions: vi.fn().mockResolvedValue([
                {
                    app: "alpaca-options",
                    ownershipStatus: "owned",
                    instrument: "SPY-IC-1",
                    side: "short",
                    quantity: 1,
                    entryPrice: 1.23,
                    syncedAt: Date.now(),
                },
                {
                    app: "alpaca-options",
                    ownershipStatus: "owned",
                    instrument: "SPY-IC-2",
                    side: "short",
                    quantity: 2,
                    entryPrice: 1.11,
                    syncedAt: Date.now(),
                },
            ]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([
                {
                    app: "alpaca-options",
                    ownershipStatus: "owned",
                    orderId: "alpaca-order-1",
                    instrument: "SPY-IC-1",
                    venue: "alpaca",
                    status: "pending",
                    quantity: 1,
                    filledQuantity: 0,
                    remainingQuantity: 1,
                    submittedAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ]),
        } as unknown as TradingBackendClient

        const verificationPromise = reconcileAndVerifyReset(client, strategy)
        const assertion = expect(verificationPromise).rejects.toThrow(
            "positions=SPY-IC-1:1, SPY-IC-2:2; orders=alpaca-order-1:SPY-IC-1"
        )

        await assertion
        setTimeoutSpy.mockRestore()
    })

    it("detects a closed provider market with a matching working close order without flatten churn", async () => {
        const venue = {
            getMarketClock: vi.fn().mockResolvedValue({
                isOpen: false,
                nextOpen: "2026-04-13T13:30:00Z",
            }),
            getPositions: vi.fn(),
            getWorkingOrders: vi.fn(),
            getAccountState: vi.fn(),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            submitOrder: vi.fn(),
            getOrderStatus: vi.fn(),
        }

        const block = await detectMarketClosedResetBlock("alpaca-options", venue, {
            positions: [
                {
                    instrument: "IC:SPY:2026-04-24:SPY260424C00705000|SPY260424C00706000|SPY260424P00649000|SPY260424P00650000",
                },
            ],
            workingOrders: [
                {
                    orderId: "close-order-1",
                    instrument: "IC:SPY:2026-04-24:SPY260424C00705000|SPY260424C00706000|SPY260424P00649000|SPY260424P00650000",
                    metadata: {
                        legs: [
                            { symbol: "SPY260424C00705000", position_intent: "sell_to_close" },
                            { symbol: "SPY260424C00706000", position_intent: "buy_to_close" },
                            { symbol: "SPY260424P00649000", position_intent: "buy_to_close" },
                            { symbol: "SPY260424P00650000", position_intent: "sell_to_close" },
                        ],
                    },
                },
            ],
        })

        expect(block).toMatchObject({
            provider: "alpaca-options",
            nextOpen: "2026-04-13T13:30:00Z",
        })
        expect(venue.cancelOrder).not.toHaveBeenCalled()
        expect(venue.closePosition).not.toHaveBeenCalled()
    })

    it("does not treat a matching open-intent order as a market-closed reset block", async () => {
        const venue = {
            getMarketClock: vi.fn().mockResolvedValue({
                isOpen: false,
            }),
            getPositions: vi.fn(),
            getWorkingOrders: vi.fn(),
            getAccountState: vi.fn(),
            cancelOrder: vi.fn(),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            submitOrder: vi.fn(),
            getOrderStatus: vi.fn(),
        }

        const block = await detectMarketClosedResetBlock("alpaca-options", venue, {
            positions: [
                {
                    instrument: "IC:SPY:2026-04-24:SPY260424C00705000|SPY260424C00706000|SPY260424P00649000|SPY260424P00650000",
                },
            ],
            workingOrders: [
                {
                    orderId: "entry-order-1",
                    instrument: "IC:SPY:2026-04-24:SPY260424C00705000|SPY260424C00706000|SPY260424P00649000|SPY260424P00650000",
                    metadata: {
                        legs: [
                            { symbol: "SPY260424C00705000", position_intent: "sell_to_open" },
                            { symbol: "SPY260424C00706000", position_intent: "buy_to_open" },
                            { symbol: "SPY260424P00649000", position_intent: "buy_to_open" },
                            { symbol: "SPY260424P00650000", position_intent: "sell_to_open" },
                        ],
                    },
                },
            ],
        })

        expect(block).toBeNull()
    })

    it("classifies Alpaca market-closed execution failures without weakening other venues", () => {
        expect(isMarketClosedExecutionFailure("alpaca-options", "position SPY: market is not open")).toBe(true)
        expect(isMarketClosedExecutionFailure("alpaca-options", "position SPY: outside market hours")).toBe(true)
        expect(isMarketClosedExecutionFailure("mt5", "position XAUUSD: market is not open")).toBe(false)
        expect(isMarketClosedExecutionFailure("alpaca-options", "position SPY: insufficient buying power")).toBe(false)
    })
})

function stubImmediateTimeout() {
    return vi.spyOn(globalThis, "setTimeout").mockImplementation((
        ((handler: TimerHandler) => {
            queueMicrotask(() => {
                if (typeof handler === "function") {
                    handler()
                }
            })
            return 0 as unknown as ReturnType<typeof setTimeout>
        }) as unknown as typeof setTimeout
    ))
}
