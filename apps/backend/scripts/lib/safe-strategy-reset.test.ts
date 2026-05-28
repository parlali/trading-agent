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
    detectMarketClosedResetBlock,
    flattenVenueExposure,
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

function createAccountState() {
    return {
        balance: 1000,
        equity: 1000,
        buyingPower: 1000,
        marginUsed: 0,
        marginAvailable: 1000,
        openPnl: 0,
        dayPnl: 0,
    }
}

function createVenueMock(overrides: Record<string, unknown> = {}) {
    return {
        getAccountState: vi.fn().mockResolvedValue(createAccountState()),
        getPositions: vi.fn().mockResolvedValue([]),
        getWorkingOrders: vi.fn().mockResolvedValue([]),
        cancelOrder: vi.fn(),
        modifyOrder: vi.fn(),
        closePosition: vi.fn(),
        submitOrder: vi.fn(),
        getOrderStatus: vi.fn(),
        ...overrides,
    }
}

function createFreshness(
    app: StoredStrategy["app"],
    overrides: Record<string, unknown> = {}
) {
    return {
        app,
        accountScope: "single-account-per-venue",
        lastSyncedAt: Date.now(),
        lastVerifiedAt: Date.now(),
        providerStatus: "healthy",
        stale: false,
        driftDetected: false,
        positionCount: 0,
        pendingOrderCount: 0,
        ...overrides,
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
        const venue = createVenueMock()

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
                .mockResolvedValueOnce([createFreshness("okx-swap")])
                .mockResolvedValueOnce([createFreshness("okx-swap", { positionCount: 1 })])
                .mockResolvedValueOnce([createFreshness("okx-swap")]),
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

    it("includes remaining exposure identifiers in verification failures", async () => {
        const setTimeoutSpy = stubImmediateTimeout()

        const strategy = createStrategy("alpaca-options")
        const venue = createVenueMock()

        vi.spyOn(AlpacaPlugin.prototype, "resolveSecretKeys").mockReturnValue([])
        vi.spyOn(AlpacaPlugin.prototype, "createVenueAdapter").mockReturnValue(venue as never)

        const client = {
            resolveSecrets: vi.fn().mockResolvedValue({}),
            reconcileProviderPortfolio: vi.fn().mockResolvedValue(undefined),
            getPortfolioFreshness: vi.fn().mockResolvedValue([
                createFreshness("alpaca-options", { positionCount: 2, pendingOrderCount: 1 }),
            ]),
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
                    status: "pending" as const,
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
        const venue = createVenueMock({
            getMarketClock: vi.fn().mockResolvedValue({
                isOpen: false,
                nextOpen: "2026-04-13T13:30:00Z",
            }),
        })

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

    it("detects closed-market deferred Alpaca raw legs with claimed structure close orders", async () => {
        const venue = createVenueMock({
            getMarketClock: vi.fn().mockResolvedValue({
                isOpen: false,
                nextOpen: "2026-04-13T13:30:00Z",
            }),
        })
        const claimInstrument = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"

        const block = await detectMarketClosedResetBlock("alpaca-options", venue, {
            positions: [
                {
                    instrument: "SPY260501P00695000",
                    side: "short",
                    quantity: 1,
                    entryPrice: 0.44,
                    metadata: {
                        alpacaClaimInstrument: claimInstrument,
                        positionKey: "SPY260501P00695000:short",
                    },
                },
                {
                    instrument: "SPY260501P00694000",
                    side: "long",
                    quantity: 1,
                    entryPrice: 0.19,
                    metadata: {
                        alpacaClaimInstrument: claimInstrument,
                        positionKey: "SPY260501P00694000:long",
                    },
                },
            ],
            workingOrders: [
                {
                    orderId: "close-order-1",
                    instrument: claimInstrument,
                    metadata: {
                        legs: [
                            { symbol: "SPY260501P00695000", position_intent: "buy_to_close" },
                            { symbol: "SPY260501P00694000", position_intent: "sell_to_close" },
                        ],
                    },
                },
            ],
        })

        expect(block).toMatchObject({
            provider: "alpaca-options",
            nextOpen: "2026-04-13T13:30:00Z",
        })
        expect(block?.positions).toHaveLength(2)
        expect(block?.workingOrders.map((order) => order.orderId)).toEqual(["close-order-1"])
    })

    it("defers Alpaca live positions with no working close orders while market is closed", async () => {
        const venue = createVenueMock({
            getMarketClock: vi.fn().mockResolvedValue({
                isOpen: false,
                nextOpen: "2026-05-20T13:30:00Z",
            }),
        })

        const block = await detectMarketClosedResetBlock("alpaca-options", venue, {
            positions: [
                {
                    instrument: "SPY260529C00754000",
                    side: "short",
                    quantity: 1,
                    entryPrice: 0.44,
                },
            ],
            workingOrders: [],
        })

        expect(block).toMatchObject({
            provider: "alpaca-options",
            nextOpen: "2026-05-20T13:30:00Z",
            workingOrders: [],
        })
        expect(block?.positions).toHaveLength(1)
    })

    it("flattens live exposure through pipeline canonical cancel and provider-position close paths", async () => {
        const pipeline = {
            cancelOrder: vi.fn(async () => ({
                orderId: "valc01abcde23456",
                status: "cancelled" as const,
                filledQuantity: 0,
                timestamp: Date.now(),
            })),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "valc01close2345",
                    status: "filled" as const,
                    filledQuantity: 1,
                    timestamp: Date.now(),
                },
                validation: { allowed: true },
            })),
        }
        const position = {
            app: "alpaca-options" as const,
            ownershipStatus: "owned" as const,
            instrument: "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000",
            providerPositionId: "claim-put-vertical",
            side: "short" as const,
            quantity: 1,
            entryPrice: 0.44,
            syncedAt: Date.now(),
            metadata: {
                legs: [
                    { instrument: "SPY260501P00694000", side: "buy_to_close" },
                    { instrument: "SPY260501P00695000", side: "sell_to_close" },
                ],
            },
        }
        const order = {
            app: "alpaca-options" as const,
            ownershipStatus: "owned" as const,
            orderId: "provider-order-1",
            canonicalOrderId: "valx01abcde23456",
            providerOrderId: "provider-order-1",
            providerClientOrderId: "valx01abcde23456",
            instrument: position.instrument,
            venue: "alpaca",
            status: "pending" as const,
            quantity: 1,
            filledQuantity: 0,
            remainingQuantity: 1,
            submittedAt: Date.now(),
            updatedAt: Date.now(),
        }

        const result = await flattenVenueExposure(pipeline, {
            positions: [position],
            workingOrders: [order],
        })

        expect(result).toMatchObject({
            cancelledOrders: 1,
            closedPositions: 1,
        })
        expect(pipeline.cancelOrder).toHaveBeenCalledWith("provider-order-1", "reset flatten")
        expect(pipeline.closeProviderPosition).toHaveBeenCalledWith(position, "reset flatten")
    })

    it("dedupes Alpaca raw provider legs into one claimed structure close during reset flattening", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "valc01close2345",
                    status: "filled" as const,
                    filledQuantity: 1,
                    timestamp: Date.now(),
                },
                validation: { allowed: true },
            })),
        }
        const claimInstrument = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"
        const positions = [
            {
                app: "alpaca-options" as const,
                ownershipStatus: "owned" as const,
                positionKey: "SPY260501P00695000:short",
                instrument: "SPY260501P00695000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.44,
                currentPrice: 0.3,
                syncedAt: Date.now(),
                metadata: {
                    alpacaClaimInstrument: claimInstrument,
                    positionKey: "SPY260501P00695000:short",
                },
            },
            {
                app: "alpaca-options" as const,
                ownershipStatus: "owned" as const,
                positionKey: "SPY260501P00694000:long",
                instrument: "SPY260501P00694000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.21,
                currentPrice: 0.16,
                syncedAt: Date.now(),
                metadata: {
                    alpacaClaimInstrument: claimInstrument,
                    positionKey: "SPY260501P00694000:long",
                },
            },
        ]

        const result = await flattenVenueExposure(pipeline, {
            positions,
            workingOrders: [],
        })

        expect(result.closedPositions).toBe(1)
        expect(pipeline.closeProviderPosition).toHaveBeenCalledTimes(1)
        expect(pipeline.closeProviderPosition).toHaveBeenCalledWith(
            expect.objectContaining({
                instrument: claimInstrument,
                metadata: expect.objectContaining({
                    alpacaCloseGroup: true,
                    providerLegs: expect.arrayContaining([
                        expect.objectContaining({ instrument: "SPY260501P00695000" }),
                        expect.objectContaining({ instrument: "SPY260501P00694000" }),
                    ]),
                }),
            }),
            "reset flatten"
        )
    })

    it("does not count pending provider-position closes as flat during reset flattening", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "valc01close2345",
                    status: "pending" as const,
                    filledQuantity: 0,
                    timestamp: Date.now(),
                },
                validation: { allowed: true },
            })),
        }
        const position = {
            app: "alpaca-options" as const,
            ownershipStatus: "owned" as const,
            instrument: "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000",
            providerPositionId: "claim-put-vertical",
            side: "short" as const,
            quantity: 1,
            entryPrice: 0.44,
            syncedAt: Date.now(),
        }

        const result = await flattenVenueExposure(pipeline, {
            positions: [position],
            workingOrders: [],
        })

        expect(result.closedPositions).toBe(0)
        expect(result.positionFailures).toEqual([
            expect.stringContaining("close status pending does not prove flat exposure"),
        ])
    })

    it("does not synthesize executable Alpaca close groups from unclaimed vertical geometry", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "valc01close2345",
                    status: "pending" as const,
                    filledQuantity: 0,
                    timestamp: Date.now(),
                },
                validation: { allowed: true },
            })),
        }
        const positions = [
            {
                app: "alpaca-options" as const,
                ownershipStatus: "unowned" as const,
                positionKey: "SPY260501P00695000:short",
                instrument: "SPY260501P00695000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.44,
                currentPrice: 0.3,
                syncedAt: Date.now(),
                metadata: {
                    positionKey: "SPY260501P00695000:short",
                },
            },
            {
                app: "alpaca-options" as const,
                ownershipStatus: "unowned" as const,
                positionKey: "SPY260501P00694000:long",
                instrument: "SPY260501P00694000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.21,
                currentPrice: 0.16,
                syncedAt: Date.now(),
                metadata: {
                    positionKey: "SPY260501P00694000:long",
                },
            },
        ]

        const result = await flattenVenueExposure(pipeline, {
            positions,
            workingOrders: [],
        })

        expect(result.closedPositions).toBe(0)
        expect(result.positionFailures).toEqual([
            expect.stringContaining("Alpaca raw option leg close requires complete claimed structure evidence"),
            expect.stringContaining("Alpaca raw option leg close requires complete claimed structure evidence"),
        ])
        expect(pipeline.closeProviderPosition).not.toHaveBeenCalled()
    })

    it("blocks raw live Alpaca option legs when force-reset has no reconciled claim metadata", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(),
        }
        const positions = [
            {
                instrument: "SPY260529C00754000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.44,
                currentPrice: 0.3,
            },
            {
                instrument: "SPY260529C00755000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.21,
                currentPrice: 0.16,
            },
        ]

        const result = await flattenVenueExposure(pipeline, {
            app: "alpaca-options",
            positions,
            workingOrders: [],
        })

        expect(result.closedPositions).toBe(0)
        expect(result.positionFailures).toEqual([
            expect.stringContaining("Alpaca raw option leg close requires complete claimed structure evidence"),
            expect.stringContaining("Alpaca raw option leg close requires complete claimed structure evidence"),
        ])
        expect(pipeline.closeProviderPosition).not.toHaveBeenCalled()
    })

    it("reconstructs valid Alpaca vertical geometry during force reset", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "valc01close2345",
                    status: "filled" as const,
                    filledQuantity: 1,
                    timestamp: Date.now(),
                },
                validation: { allowed: true },
            })),
        }
        const positions = [
            {
                instrument: "SPY260529C00754000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.44,
                currentPrice: 0.3,
            },
            {
                instrument: "SPY260529C00755000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.21,
                currentPrice: 0.16,
            },
            {
                instrument: "SPY260529P00679000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.21,
                currentPrice: 0.16,
            },
            {
                instrument: "SPY260529P00680000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.44,
                currentPrice: 0.3,
            },
            {
                instrument: "SPY260529P00715000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.21,
                currentPrice: 0.16,
            },
            {
                instrument: "SPY260529P00716000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.44,
                currentPrice: 0.3,
            },
        ]

        const result = await flattenVenueExposure(pipeline, {
            app: "alpaca-options",
            positions,
            workingOrders: [],
            forceReset: true,
        })

        expect(result.closedPositions).toBe(3)
        expect(result.positionFailures).toEqual([])
        expect(pipeline.closeProviderPosition).toHaveBeenCalledTimes(3)
        expect(pipeline.closeProviderPosition).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    alpacaEmergencyCloseGroup: true,
                    alpacaCloseGroup: true,
                }),
            }),
            "reset flatten"
        )
    })

    it("does not synthesize Alpaca close groups across unknown ownership scopes", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(),
        }
        const positions = [
            {
                app: "alpaca-options" as const,
                ownershipStatus: "owned" as const,
                strategyId: "strategy-a",
                positionKey: "SPY260501C00720000:short",
                instrument: "SPY260501C00720000",
                side: "short" as const,
                quantity: 1,
                entryPrice: 0.3,
                currentPrice: 0.2,
                syncedAt: Date.now(),
                metadata: {
                    positionKey: "SPY260501C00720000:short",
                },
            },
            {
                app: "alpaca-options" as const,
                ownershipStatus: "orphaned" as const,
                positionKey: "SPY260501C00721000:long",
                instrument: "SPY260501C00721000",
                side: "long" as const,
                quantity: 1,
                entryPrice: 0.12,
                currentPrice: 0.08,
                syncedAt: Date.now(),
                metadata: {
                    positionKey: "SPY260501C00721000:long",
                },
            },
        ]

        const result = await flattenVenueExposure(pipeline, {
            positions,
            workingOrders: [],
        })

        expect(result.closedPositions).toBe(0)
        expect(result.positionFailures).toHaveLength(2)
        expect(pipeline.closeProviderPosition).not.toHaveBeenCalled()
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
