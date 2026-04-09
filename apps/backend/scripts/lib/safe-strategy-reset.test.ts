import { afterEach, describe, expect, it, vi } from "vitest"
import type {
    DeleteStrategyResult,
    Id,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"
import { BinancePlugin } from "../../src/plugins/binance"
import {
    isDryRunStrategy,
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
    const policy = app === "binance-futures"
        ? {
            dryRun: false,
            model: "openai/gpt-5.4",
            allowedInstruments: ["BTCUSDT"],
            maxLeverage: 2,
            maxRiskPercent: 1,
            tradingHours: {
                start: "00:00",
                end: "23:59",
                timezone: "UTC",
            },
            emergencyFlattenThreshold: 1000,
            fundingRateThreshold: 0.003,
            requireTakeProfit: false,
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
            emergencyFlattenThreshold: 1000,
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

    it("supports binance strategies in the safe reset flow", async () => {
        const strategy = createStrategy("binance-futures")
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

        vi.spyOn(BinancePlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(BinancePlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getPortfolioPositions: vi.fn().mockResolvedValue([]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([]),
            getPortfolioFreshness: vi.fn().mockResolvedValue([{
                app: "binance-futures",
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
        vi.useFakeTimers()

        const strategy = createStrategy("binance-futures")
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

        vi.spyOn(BinancePlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(BinancePlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getPortfolioPositions: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ instrument: "BTCUSDT" }])
                .mockResolvedValueOnce([]),
            getPortfolioPendingOrders: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]),
            getPortfolioFreshness: vi.fn()
                .mockResolvedValueOnce([{
                    app: "binance-futures",
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
                    app: "binance-futures",
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
                    app: "binance-futures",
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

        await vi.runAllTimersAsync()

        await expect(resetPromise).resolves.toMatchObject({
            deleted: deleteResult,
        })

        expect(client.reconcileProviderPortfolio).toHaveBeenCalledTimes(2)
    })

    it("allows destructive verification when exposure is flat but drift state remains degraded", async () => {
        const strategy = createStrategy("binance-futures")
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

        vi.spyOn(BinancePlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(BinancePlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            resolveSecrets: vi.fn().mockResolvedValue({}),
            reconcileProviderPortfolio: vi.fn().mockResolvedValue(undefined),
            getPortfolioFreshness: vi.fn().mockResolvedValue([{
                app: "binance-futures",
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
})
