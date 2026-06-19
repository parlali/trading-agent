import { afterEach, describe, expect, it, vi } from "vitest"
import {
    createLogger,
    ExecutionPipeline,
    type OrderPersistenceAdapter,
    type OrderSnapshot,
} from "@valiq-trading/core"
import { OKXPlugin } from "./okx"
import { MT5Plugin } from "./mt5.ts"
import { executeAuditedSessionFlat } from "../session-flat"

const logger = createLogger({ minLevel: "fatal" })

function createPolicy(app: "okx-swap" | "mt5") {
    return app === "okx-swap"
        ? {
            llm: {
                provider: "openrouter",
                model: "openai/gpt-5.5",
            },
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
            llm: {
                provider: "openrouter",
                model: "openai/gpt-5.5",
            },
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
        vi.restoreAllMocks()
    })

    it("OKX closes and cancels only the active strategy-owned exposure", async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-27T23:50:00.000Z"))

        const sessionFlatExecute = vi.fn(async () => ({
            cancelled: 1,
            closed: 1,
            cancelResults: [{
                orderId: "order-btc",
                status: "cancelled" as const,
                filledQuantity: 0,
                timestamp: Date.now(),
            }],
            closeResults: [{
                orderId: "close-btc",
                status: "filled" as const,
                filledQuantity: 1,
                timestamp: Date.now(),
            }],
        }))

        const result = await new OKXPlugin().preRunHooks({
            venue: {
                getMarketSnapshot: vi.fn(),
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
            sessionFlat: {
                execute: sessionFlatExecute,
            },
        })

        expect(result).toMatchObject({
            skip: true,
            providerStateChanged: true,
        })
        expect(sessionFlatExecute).toHaveBeenCalledTimes(1)
        expect(sessionFlatExecute).toHaveBeenCalledWith(expect.objectContaining({
            positions: [expect.objectContaining({
                instrument: "BTC-USDT-SWAP",
            })],
            workingOrders: [expect.objectContaining({
                orderId: "order-btc",
            })],
        }))
    })

    it("MT5 closes by provider position and does not use account-wide bulk close", async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-27T20:50:00.000Z"))

        const sessionFlatExecute = vi.fn(async () => ({
            cancelled: 0,
            closed: 1,
            cancelResults: [],
            closeResults: [{
                orderId: "1600791764",
                status: "filled" as const,
                filledQuantity: 0.01,
                timestamp: Date.now(),
            }],
        }))
        const closeAllPositions = vi.fn()

        const result = await new MT5Plugin().preRunHooks({
            venue: {
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
            sessionFlat: {
                execute: sessionFlatExecute,
            },
        })

        expect(result).toMatchObject({
            skip: true,
            providerStateChanged: true,
        })
        expect(sessionFlatExecute).toHaveBeenCalledWith(expect.objectContaining({
            positions: [expect.objectContaining({
                providerPositionId: "1600791764",
            })],
        }))
        expect(closeAllPositions).not.toHaveBeenCalled()
    })

    it("MT5 fails closed when configured symbols are not provider-verified before a run", async () => {
        const policy = createPolicy("mt5")
        policy.safety.sessionFlat.enabled = false

        await expect(new MT5Plugin().preRunHooks({
            venue: {
                getMarketSnapshot: vi.fn(async () => []),
            } as never,
            policy,
            strategyId: "gold-strategy",
            ownedInstruments: new Set(["XAUUSD"]),
            ownedPositions: [],
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
            sessionFlat: {
                execute: vi.fn(),
            },
        })).rejects.toThrow("configured broker symbol(s) were not returned by the provider")
    })

    it("MT5 fails closed before provider preflight when no broker symbols are configured", async () => {
        const policy = createPolicy("mt5")
        policy.safety.sessionFlat.enabled = false
        policy.marketRegionsByInstrument = undefined
        const getMarketSnapshot = vi.fn()

        await expect(new MT5Plugin().preRunHooks({
            venue: {
                getMarketSnapshot,
            } as never,
            policy,
            strategyId: "gold-strategy",
            ownedInstruments: new Set(["XAUUSD"]),
            ownedPositions: [],
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
            sessionFlat: {
                execute: vi.fn(),
            },
        })).rejects.toThrow("requires at least one configured broker symbol")
        expect(getMarketSnapshot).not.toHaveBeenCalled()
    })

    it("records audited close lifecycle state through the shared session-flat executor", async () => {
        const snapshots = new Map<string, OrderSnapshot>()
        const persistence: OrderPersistenceAdapter = {
            async upsertOrder(snapshot) {
                snapshots.set(snapshot.orderId, snapshot)
            },
            async logOrderTransition() {
                return 1
            },
            async getOrder(orderId) {
                return snapshots.get(orderId) ?? null
            },
            async listActiveOrders() {
                return []
            },
        }
        const venue = {
            getPositions: vi.fn(async () => []),
            getAccountState: vi.fn(),
            submitOrder: vi.fn(),
            cancelOrder: vi.fn(async (orderId: string) => ({
                orderId,
                status: "cancelled" as const,
                filledQuantity: 0,
                timestamp: Date.now(),
            })),
            modifyOrder: vi.fn(),
            closePosition: vi.fn(),
            closeProviderPosition: vi.fn(async () => ({
                orderId: "order:BTC-USDT-SWAP:session-flat-close",
                status: "filled" as const,
                filledQuantity: 0.1,
                fillPrice: 79_900,
                timestamp: Date.now(),
            })),
            getOrderStatus: vi.fn(),
        }
        const pipeline = new ExecutionPipeline({
            venue,
            venueName: "okx",
            policy: { dryRun: false },
            logger,
            orderPersistence: persistence,
            runId: "run-session-flat",
            strategyId: "strategy-session-flat",
        })

        const result = await executeAuditedSessionFlat({
            pipeline,
            logger,
            strategyId: "strategy-session-flat",
            app: "okx-swap",
            positions: [{
                instrument: "BTC-USDT-SWAP",
                side: "long",
                quantity: 0.1,
                entryPrice: 80_000,
                providerPositionId: "pos-1",
            }],
            workingOrders: [],
            reason: "session-flat replay",
        })

        expect(result).toMatchObject({
            cancelled: 0,
            closed: 1,
        })
        expect(venue.closeProviderPosition).toHaveBeenCalledWith(
            expect.objectContaining({ providerPositionId: "pos-1" }),
            expect.objectContaining({
                metadata: expect.objectContaining({
                    action: "close",
                    sessionFlat: true,
                    providerPositionId: "pos-1",
                }),
            }),
            expect.objectContaining({
                identity: expect.objectContaining({
                    canonicalOrderId: expect.stringMatching(/^vokc01/),
                    providerClientOrderId: expect.stringMatching(/^vokc01/),
                }),
            })
        )
        const [snapshot] = Array.from(snapshots.values())
        expect(snapshot).toMatchObject({
            providerOrderId: "order:BTC-USDT-SWAP:session-flat-close",
            status: "filled",
            action: "close",
            filledQuantity: 0.1,
        })
    })

    it("fails closed when an audited session-flat close is rejected", async () => {
        const pipeline = {
            cancelOrder: vi.fn(async () => ({
                orderId: "order-ok",
                status: "cancelled" as const,
                filledQuantity: 0,
                timestamp: Date.now(),
            })),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "close-rejected",
                    status: "rejected" as const,
                    filledQuantity: 0,
                    timestamp: Date.now(),
                },
                validation: {
                    allowed: true,
                },
            })),
        }

        await expect(executeAuditedSessionFlat({
            pipeline,
            logger,
            strategyId: "strategy-session-flat",
            app: "mt5",
            positions: [{
                instrument: "XAUUSD",
                providerPositionId: "1600791764",
                side: "long",
                quantity: 0.01,
                entryPrice: 3330,
            }],
            workingOrders: [],
            reason: "session-flat replay",
        })).rejects.toThrow("Audited session-flat failed")
    })

    it("fails closed when an audited session-flat close only partially fills", async () => {
        const pipeline = {
            cancelOrder: vi.fn(),
            closeProviderPosition: vi.fn(async () => ({
                result: {
                    orderId: "close-partial",
                    status: "partially_filled" as const,
                    filledQuantity: 0.005,
                    timestamp: Date.now(),
                },
                validation: {
                    allowed: true,
                },
            })),
        }

        await expect(executeAuditedSessionFlat({
            pipeline,
            logger,
            strategyId: "strategy-session-flat",
            app: "mt5",
            positions: [{
                instrument: "XAUUSD",
                providerPositionId: "1600791764",
                side: "long",
                quantity: 0.01,
                entryPrice: 3330,
            }],
            workingOrders: [],
            reason: "session-flat replay",
        })).rejects.toThrow("Audited session-flat failed")
    })
})
