import { describe, expect, it, vi } from "vitest"
import {
    DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
    ExecutionPipeline,
    resolveDryRunAccountState,
    type PriceVerifier,
    type TradeEventLogger,
    type VenueAdapter,
} from "./execution.ts"
import { assessExecutionCost, resolveExecutionCostMetrics } from "./execution-cost.ts"
import { createLogger } from "./logger.ts"
import type { AccountState, ExecutionResult, OrderIntent, Position, ValidationResult } from "./types.ts"

const account: AccountState = {
    balance: 1000,
    equity: 1000,
    buyingPower: 1000,
    marginUsed: 0,
    marginAvailable: 1000,
    openPnl: 0,
    dayPnl: 0,
}

function createVenue(): VenueAdapter {
    return {
        getPositions: async () => [],
        getAccountState: async () => account,
        submitOrder: async () => ({
            orderId: "live-order",
            status: "filled",
            filledQuantity: 1,
            timestamp: Date.now(),
        }),
        cancelOrder: async (orderId: string) => ({
            orderId,
            status: "cancelled",
            filledQuantity: 0,
            timestamp: Date.now(),
        }),
        modifyOrder: async (orderId: string) => ({
            orderId,
            status: "pending",
            filledQuantity: 0,
            timestamp: Date.now(),
        }),
        closePosition: async (instrument: string) => ({
            orderId: `close-${instrument}`,
            status: "filled",
            filledQuantity: 1,
            timestamp: Date.now(),
        }),
        getOrderStatus: async (orderId: string) => ({
            orderId,
            status: "filled",
            filledQuantity: 1,
            timestamp: Date.now(),
        }),
    }
}

function createTradeLogger() {
    return {
        logIntent: vi.fn(async () => {}),
        logValidation: vi.fn(async () => {}),
        logSubmission: vi.fn(async () => {}),
        logFillUpdate: vi.fn(async () => {}),
    } satisfies TradeEventLogger
}

function createBlockedExecutionCost() {
    return assessExecutionCost(
        resolveExecutionCostMetrics({
            app: "polymarket",
            instrument: "token-yes",
            instrumentClass: "prediction_market",
            capturedAt: Date.UTC(2026, 3, 23, 14, 0, 0),
            bestBid: 0.41,
            bestAsk: 0.59,
            midpoint: 0.5,
            referencePrice: 0.5,
            absoluteSpread: 0.18,
            nativeSpread: 0.18,
            nativeSpreadUnit: "probability",
            liquidityWarning: true,
        })
    )
}

describe("ExecutionPipeline dry-run accounting", () => {
    it("keeps deterministic cash and realized PnL after closing a virtual position", async () => {
        const tradeLogger = createTradeLogger()
        const pipeline = new ExecutionPipeline({
            venue: createVenue(),
            venueName: "polymarket",
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            logger: createLogger({ minLevel: "fatal" }),
            tradeEventLogger: tradeLogger,
            runId: "run-1",
            strategyId: "strategy-1",
        })

        pipeline.seedDryRunPositions([
            {
                instrument: "token-yes",
                side: "long",
                quantity: 10,
                entryPrice: 0.5,
                currentPrice: 0.5,
                unrealizedPnl: 0,
                metadata: {
                    tokenId: "token-yes",
                    conditionId: "condition-1",
                    marketSlug: "market-1",
                    question: "Will it happen?",
                    outcome: "Yes",
                },
            },
        ])

        await pipeline.closePosition("token-yes", "take profit", {
            estimatedPrice: 0.7,
        })

        const state = await pipeline.getAccountState()
        expect(state.balance).toBeCloseTo(1002)
        expect(state.equity).toBeCloseTo(1002)
        expect(state.dayPnl).toBeCloseTo(2)
        expect(state.openPnl).toBeCloseTo(0)
        const agentPositions = pipeline.getDryRunPositions()
        expect(agentPositions).toHaveLength(0)

        const syncedPositions = pipeline.getDryRunPositionsForSync()
        expect(syncedPositions).toHaveLength(1)
        const ledger = syncedPositions[0]!
        expect(ledger).toMatchObject({
            instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
            metadata: expect.objectContaining({
                cashAdjustment: 2,
                realizedPnl: expect.closeTo(2),
            }),
        })

        const submission = tradeLogger.logSubmission.mock.calls.at(-1) as unknown as [
            string,
            string,
            ExecutionResult,
            OrderIntent,
        ]
        expect(submission[3].metadata).toMatchObject({
            tokenId: "token-yes",
            conditionId: "condition-1",
            marketSlug: "market-1",
            question: "Will it happen?",
            outcome: "Yes",
            action: "close",
        })
    })

    it("persists canonical dry-run position metadata with fill accounting fields", async () => {
        const pipeline = new ExecutionPipeline({
            venue: createVenue(),
            venueName: "polymarket",
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            riskValidators: [
                (
                    intent: OrderIntent,
                    _policy: Record<string, unknown>,
                    _state: AccountState,
                    _positions: Position[]
                ): ValidationResult => ({ allowed: true, adjustedIntent: intent }),
            ],
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-2",
            strategyId: "strategy-1",
        })

        await pipeline.executeIntent(
            {
                instrument: "token-yes",
                side: "buy",
                quantity: 5,
                orderType: "limit",
                limitPrice: 0.4,
                timeInForce: "gtc",
                metadata: {
                    tokenId: "token-yes",
                    conditionId: "condition-1",
                    marketSlug: "market-1",
                    question: "Will it happen?",
                    outcome: "Yes",
                    currentPrice: 0.45,
                },
            },
            account,
            []
        )

        expect(pipeline.getDryRunPositions()[0]?.metadata).toMatchObject({
            tokenId: "token-yes",
            conditionId: "condition-1",
            marketSlug: "market-1",
            question: "Will it happen?",
            outcome: "Yes",
            side: "buy",
            quantity: 5,
            entryPrice: 0.4,
            currentPrice: 0.45,
            sourceRunId: "run-2",
        })
    })

    it("seeds virtual account cash from the persisted dry-run ledger row", async () => {
        const pipeline = new ExecutionPipeline({
            venue: createVenue(),
            venueName: "polymarket",
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-3",
            strategyId: "strategy-1",
        })

        pipeline.seedDryRunPositions([
            {
                instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
                side: "long",
                quantity: 0,
                entryPrice: 0,
                currentPrice: 0,
                unrealizedPnl: 0,
                metadata: {
                    dryRunLedger: true,
                    cashAdjustment: 2,
                    realizedPnl: 2,
                },
            },
        ])

        const state = await pipeline.getAccountState()
        expect(state.balance).toBe(1002)
        expect(state.equity).toBe(1002)
        expect(state.dayPnl).toBe(2)
        expect(await pipeline.getPositions()).toEqual([])
    })

    it("reconstructs dry-run account state from stored positions before the next run", () => {
        const state = resolveDryRunAccountState({
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            positions: [
                {
                    instrument: "BTC-USDT-SWAP",
                    side: "long",
                    quantity: 2,
                    entryPrice: 100,
                    currentPrice: 110,
                    unrealizedPnl: 20,
                },
                {
                    instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
                    side: "long",
                    quantity: 0,
                    entryPrice: 0,
                    currentPrice: 0,
                    unrealizedPnl: 0,
                    metadata: {
                        dryRunLedger: true,
                        cashAdjustment: -180,
                        realizedPnl: 5,
                    },
                },
            ],
        })

        expect(state.balance).toBe(820)
        expect(state.equity).toBe(1040)
        expect(state.openPnl).toBe(20)
        expect(state.dayPnl).toBe(25)
        expect(state.marginUsed).toBe(220)
    })

    it("values virtual short positions as liabilities instead of long inventory", async () => {
        const pipeline = new ExecutionPipeline({
            venue: createVenue(),
            venueName: "mt5",
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-4",
            strategyId: "strategy-1",
        })

        pipeline.seedDryRunPositions([
            {
                instrument: "XAUUSD",
                side: "short",
                quantity: 2,
                entryPrice: 100,
                currentPrice: 90,
            },
        ])

        const state = await pipeline.getAccountState()

        expect(state.balance).toBe(1200)
        expect(state.equity).toBe(1020)
        expect(state.marginUsed).toBe(180)
        expect(state.openPnl).toBe(20)
        expect(state.dayPnl).toBe(20)
    })

    it("fails closed before submission when required price verification throws", async () => {
        const submitOrder = vi.fn(createVenue().submitOrder)
        const venue: VenueAdapter & PriceVerifier = {
            ...createVenue(),
            submitOrder,
            verify: async () => {
                throw new Error("provider price unavailable")
            },
        }
        const pipeline = new ExecutionPipeline({
            venue,
            venueName: "polymarket",
            policy: {
                dryRun: false,
            },
            riskValidators: [
                (
                    intent: OrderIntent,
                    _policy: Record<string, unknown>,
                    _state: AccountState,
                    _positions: Position[]
                ): ValidationResult => ({ allowed: true, adjustedIntent: intent }),
            ],
            priceVerification: {
                failClosedOnVerificationError: true,
            },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-5",
            strategyId: "strategy-1",
        })

        const { result } = await pipeline.executeIntent(
            {
                instrument: "token-yes",
                side: "buy",
                quantity: 5,
                orderType: "limit",
                limitPrice: 0.4,
                timeInForce: "gtc",
            },
            account,
            []
        )

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("Price verification failed closed")
        expect(submitOrder).not.toHaveBeenCalled()
    })

    it("uses venue close-intent metadata when grouped structures are resolved provider-side", async () => {
        let capturedIntent: OrderIntent | undefined
        const venue: VenueAdapter = {
            ...createVenue(),
            getPositions: async () => [],
            buildCloseIntent: async () => ({
                instrument: "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00649000|SPY260424P00650000",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 0.42,
                timeInForce: "day",
                legs: [
                    {
                        instrument: "SPY260424P00650000",
                        side: "buy_to_close",
                        quantity: 1,
                    },
                    {
                        instrument: "SPY260424P00649000",
                        side: "sell_to_close",
                        quantity: 1,
                    },
                ],
                metadata: {
                    structureType: "credit_vertical",
                    verticalSpreadType: "bull_put_credit",
                    underlying: "SPY",
                    expiration: "2026-04-24",
                    entryPrice: 0.9,
                    positionSide: "short",
                    estimatedPrice: 0.41,
                },
            }),
            closePosition: async (_instrument: string, preparedIntent?: OrderIntent) => {
                capturedIntent = preparedIntent
                return {
                    orderId: "close-vertical-1",
                    status: "filled",
                    filledQuantity: 1,
                    fillPrice: 0.42,
                    timestamp: Date.now(),
                }
            },
        }
        const pipeline = new ExecutionPipeline({
            venue,
            venueName: "alpaca-options",
            policy: {
                dryRun: false,
            },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-6",
            strategyId: "strategy-1",
        })

        const { result, validation } = await pipeline.closePosition(
            "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00649000|SPY260424P00650000",
            "stop loss",
            {
                estimatedPrice: 0.4,
                metadata: {
                    requestedBy: "agent",
                },
            }
        )

        expect(validation.allowed).toBe(true)
        expect(result.status).toBe("filled")
        expect(capturedIntent).toMatchObject({
            side: "buy",
            orderType: "limit",
            limitPrice: 0.42,
            metadata: {
                action: "close",
                reason: "stop loss",
                structureType: "credit_vertical",
                verticalSpreadType: "bull_put_credit",
                entryPrice: 0.9,
                positionSide: "short",
                estimatedPrice: 0.4,
                requestedBy: "agent",
            },
        })
    })
})

describe("ExecutionPipeline execution-cost gating", () => {
    it("blocks new entries when canonical execution cost is blocked", async () => {
        const submitOrder = vi.fn(createVenue().submitOrder)
        const venue: VenueAdapter & PriceVerifier = {
            ...createVenue(),
            submitOrder,
            verify: async () => ({
                ok: true,
                livePrices: {
                    bid: 0.41,
                    ask: 0.59,
                    mid: 0.5,
                    spread: 0.18,
                },
                proposedPrice: 0.52,
                drift: 0.02,
                driftPercent: 4,
                executionCost: createBlockedExecutionCost(),
                message: "Captured live Polymarket prices before submission.",
            }),
        }
        const pipeline = new ExecutionPipeline({
            venue,
            venueName: "polymarket",
            policy: {
                dryRun: false,
            },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-cost-1",
            strategyId: "strategy-1",
        })

        const { result } = await pipeline.executeIntent({
            instrument: "token-yes",
            side: "buy",
            quantity: 5,
            orderType: "limit",
            limitPrice: 0.52,
            timeInForce: "gtc",
            metadata: {
                action: "entry",
            },
        }, account, [])

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("Blocked by execution-cost validation")
        expect(result.priceVerification?.status).toBe("block")
        expect(submitOrder).not.toHaveBeenCalled()
    })

    it("allows risk-reducing adjustments even when execution cost is blocked", async () => {
        const submitOrder = vi.fn(createVenue().submitOrder)
        const venue: VenueAdapter & PriceVerifier = {
            ...createVenue(),
            submitOrder,
            verify: async () => ({
                ok: true,
                livePrices: {
                    bid: 0.41,
                    ask: 0.59,
                    mid: 0.5,
                    spread: 0.18,
                },
                proposedPrice: 0.41,
                drift: -0.09,
                driftPercent: -18,
                executionCost: createBlockedExecutionCost(),
                message: "Captured live Polymarket prices before submission.",
            }),
        }
        const pipeline = new ExecutionPipeline({
            venue,
            venueName: "polymarket",
            policy: {
                dryRun: false,
            },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-cost-2",
            strategyId: "strategy-1",
        })

        const positions: Position[] = [
            {
                instrument: "token-yes",
                side: "long",
                quantity: 10,
                entryPrice: 0.5,
                currentPrice: 0.5,
            },
        ]

        const { result } = await pipeline.executeIntent({
            instrument: "token-yes",
            side: "sell",
            quantity: 5,
            orderType: "limit",
            limitPrice: 0.41,
            timeInForce: "gtc",
            metadata: {
                action: "adjustment",
                riskReducing: true,
            },
        }, account, positions, { action: "adjustment" })

        expect(result.status).toBe("filled")
        expect(result.priceVerification?.status).not.toBe("block")
        expect(submitOrder).toHaveBeenCalledTimes(1)
    })
})
