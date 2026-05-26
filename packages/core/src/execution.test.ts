import { describe, expect, it, vi } from "vitest"
import {
    DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
    ExecutionPipeline,
    resolveDryRunAccountState,
    type ExecutionPipelineConfig,
    type PriceVerifier,
    type SubmitOrderContext,
    type TradeEventLogger,
    type VenueAdapter,
} from "./execution.ts"
import { assessExecutionCost, resolveExecutionCostMetrics } from "./execution-cost.ts"
import { createLogger } from "./logger.ts"
import { createExecutionError } from "./utils.ts"
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

const testLogger = createLogger({ minLevel: "fatal" })

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

function createPipeline(config: Partial<ExecutionPipelineConfig> = {}): ExecutionPipeline {
    return new ExecutionPipeline({
        venue: createVenue(),
        venueName: "polymarket",
        policy: {
            dryRun: false,
            safety: {
                account: {
                    allocationPercent: 100,
                },
            },
        },
        logger: testLogger,
        runId: "run-1",
        strategyId: "strategy-1",
        ...config,
    })
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

describe("ExecutionPipeline commit-unknown safety", () => {
    it("blocks same-run same-instrument entry retries after submit uncertainty", async () => {
        const faultRecorder = vi.fn(async () => {})
        const venue = {
            ...createVenue(),
            submitOrder: vi.fn(async () => {
                throw createExecutionError("venue", "IPC recv failed", {
                    code: "IPC_RECV_FAILED",
                    retryable: true,
                })
            }),
            recoverSubmittedOrder: vi.fn(async () => ({
                outcome: "not_found" as const,
                message: "No provider order found yet",
                details: {
                    probe: "open_orders",
                },
            })),
        }
        const pipeline = createPipeline({
            venue,
            venueName: "mt5",
            executionSafetyFaultRecorder: faultRecorder,
        })
        const intent: OrderIntent = {
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "market",
            timeInForce: "gtc",
        }

        const first = await pipeline.executeIntent(intent, account, [])
        const second = await pipeline.executeIntent(intent, account, [])

        expect(first.result.commitOutcome).toBe("commit_unknown")
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            instrument: "XAUUSD",
            category: "commit_unknown",
            canonicalOrderId: expect.stringMatching(/^vmte01[a-z2-7]{10}$/),
            providerClientOrderId: expect.stringMatching(/^vmte01[a-z2-7]{10}$/),
            submitAttemptSequence: 1,
            commitOutcome: "commit_unknown",
        }))
        expect(second.validation.allowed).toBe(false)
        expect(second.validation.reason).toContain("unresolved commit-unknown")
        expect(venue.submitOrder).toHaveBeenCalledTimes(1)
    })

    it("captures recovery probe failures as commit-unknown instead of escaping", async () => {
        const faultRecorder = vi.fn(async () => {})
        const venue = {
            ...createVenue(),
            submitOrder: vi.fn(async () => {
                throw createExecutionError("venue", "submit timed out after send", {
                    code: "SUBMIT_TIMEOUT",
                    retryable: true,
                })
            }),
            recoverSubmittedOrder: vi.fn(async () => {
                throw createExecutionError("network", "open-order read failed", {
                    code: "RECOVERY_READ_FAILED",
                    retryable: true,
                })
            }),
        }
        const pipeline = createPipeline({
            venue,
            venueName: "alpaca-options",
            executionSafetyFaultRecorder: faultRecorder,
        })

        const result = await pipeline.executeIntent({
            instrument: "SPY260424C00650000",
            side: "buy",
            quantity: 1,
            orderType: "limit",
            limitPrice: 1.25,
            timeInForce: "day",
        }, account, [])

        expect(result.result.commitOutcome).toBe("commit_unknown")
        expect(result.result.errorDetail?.message).toContain("Provider recovery probe failed closed")
        expect(faultRecorder).toHaveBeenCalledOnce()
    })

    it("recovers a returned rejected submit result when provider truth shows a live order", async () => {
        const faultRecorder = vi.fn(async () => {})
        const venue = {
            ...createVenue(),
            submitOrder: vi.fn(async (_intent: OrderIntent, context?: SubmitOrderContext) => ({
                orderId: context?.identity.canonicalOrderId ?? "canonical",
                canonicalOrderId: context?.identity.canonicalOrderId,
                providerClientOrderId: context?.identity.providerClientOrderId,
                submitAttemptId: context?.identity.submitAttemptId,
                submitAttemptSequence: context?.identity.submitAttemptSequence,
                status: "rejected" as const,
                filledQuantity: 0,
                timestamp: Date.now(),
                error: "Provider returned rejected while broker order may have been placed",
            })),
            recoverSubmittedOrder: vi.fn(async (_intent: OrderIntent, context: SubmitOrderContext) => ({
                outcome: "accepted" as const,
                result: {
                    orderId: "1668935417",
                    providerOrderId: "1668935417",
                    providerClientOrderId: context.identity.providerClientOrderId,
                    status: "pending" as const,
                    filledQuantity: 0,
                    timestamp: Date.now(),
                },
            })),
        }
        const pipeline = createPipeline({
            venue,
            venueName: "mt5",
            executionSafetyFaultRecorder: faultRecorder,
        })

        const result = await pipeline.executeIntent({
            instrument: "XAUUSD",
            side: "sell",
            quantity: 0.02,
            orderType: "limit",
            limitPrice: 4538.5,
            timeInForce: "gtc",
        }, account, [])

        expect(result.result.status).toBe("pending")
        expect(result.result.commitOutcome).toBe("recovered")
        expect(result.result.providerOrderId).toBe("1668935417")
        expect(result.result.providerClientOrderId).toMatch(/^vmte01[a-z2-7]{10}$/)
        expect(venue.recoverSubmittedOrder).toHaveBeenCalledOnce()
        expect(faultRecorder).not.toHaveBeenCalled()
    })

    it("keeps a returned rejected submit result rejected when provider recovery finds nothing", async () => {
        const faultRecorder = vi.fn(async () => {})
        const venue = {
            ...createVenue(),
            submitOrder: vi.fn(async (_intent: OrderIntent, context?: SubmitOrderContext) => ({
                orderId: context?.identity.canonicalOrderId ?? "canonical",
                canonicalOrderId: context?.identity.canonicalOrderId,
                providerClientOrderId: context?.identity.providerClientOrderId,
                submitAttemptId: context?.identity.submitAttemptId,
                submitAttemptSequence: context?.identity.submitAttemptSequence,
                status: "rejected" as const,
                filledQuantity: 0,
                timestamp: Date.now(),
                error: "Invalid price",
            })),
            recoverSubmittedOrder: vi.fn(async () => ({
                outcome: "not_found" as const,
                message: "No provider order found with the canonical client id",
            })),
        }
        const pipeline = createPipeline({
            venue,
            venueName: "mt5",
            executionSafetyFaultRecorder: faultRecorder,
        })

        const result = await pipeline.executeIntent({
            instrument: "XAUUSD",
            side: "sell",
            quantity: 0.02,
            orderType: "limit",
            limitPrice: 1,
            timeInForce: "gtc",
        }, account, [])

        expect(result.result.status).toBe("rejected")
        expect(result.result.commitOutcome).toBe("rejected")
        expect(venue.recoverSubmittedOrder).toHaveBeenCalledOnce()
        expect(faultRecorder).not.toHaveBeenCalled()
    })

    it("persists ambiguous recovery matches as provider aliases on the commit-unknown fault", async () => {
        const faultRecorder = vi.fn(async () => {})
        const venue = {
            ...createVenue(),
            submitOrder: vi.fn(async () => {
                throw createExecutionError("venue", "IPC recv failed", {
                    code: "IPC_RECV_FAILED",
                    retryable: true,
                })
            }),
            recoverSubmittedOrder: vi.fn(async () => ({
                outcome: "ambiguous" as const,
                message: "multiple MT5 tickets share the canonical comment",
                matches: [
                    {
                        orderId: "1607001000",
                        providerOrderId: "1607001000",
                        providerClientOrderId: "vmte01duplicate1",
                        status: "pending" as const,
                        filledQuantity: 0,
                        timestamp: Date.now(),
                    },
                    {
                        orderId: "1607001001",
                        providerOrderId: "1607001001",
                        providerClientOrderId: "vmte01duplicate1",
                        status: "pending" as const,
                        filledQuantity: 0,
                        timestamp: Date.now(),
                    },
                ],
                details: {
                    tickets: [1607001000, 1607001001],
                },
            })),
        }
        const pipeline = createPipeline({
            venue,
            venueName: "mt5",
            executionSafetyFaultRecorder: faultRecorder,
        })

        const result = await pipeline.executeIntent({
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "limit",
            limitPrice: 4715.5,
            timeInForce: "gtc",
        }, account, [])

        expect(result.result.commitOutcome).toBe("commit_unknown")
        expect(result.result.providerOrderAliases).toEqual([
            "1607001000",
            "1607001001",
        ])
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            category: "duplicate_exposure",
            providerOrderAliases: [
                "1607001000",
                "1607001001",
            ],
            recoveryProbeEvidence: expect.objectContaining({
                outcome: "ambiguous",
                details: {
                    tickets: [1607001000, 1607001001],
                },
            }),
        }))
    })

    it("passes canonical close identity through provider-position reset closes", async () => {
        const closeProviderPosition = vi.fn(async (_position: Position, _intent: OrderIntent | undefined, context?: SubmitOrderContext) => ({
            orderId: "provider-close-order",
            providerOrderId: "provider-close-order",
            providerClientOrderId: context?.identity.providerClientOrderId,
            status: "pending" as const,
            filledQuantity: 0,
            timestamp: Date.now(),
        }))
        const orderPersistence = {
            upsertOrder: vi.fn(async () => {}),
            logOrderTransition: vi.fn(async () => 1),
            getOrder: vi.fn(async () => null),
            listActiveOrders: vi.fn(async () => []),
        }
        const pipeline = createPipeline({
            venue: {
                ...createVenue(),
                closeProviderPosition,
            },
            venueName: "okx-swap",
            orderPersistence,
        })

        const result = await pipeline.closeProviderPosition({
            instrument: "BTC-USDT-SWAP",
            providerPositionId: "pos-1",
            side: "short",
            quantity: 0.5,
            entryPrice: 95000,
            currentPrice: 94000,
        }, "reset flatten")

        const context = closeProviderPosition.mock.calls[0]?.[2]
        expect(context?.identity.canonicalOrderId).toMatch(/^vokc01[a-z2-7]{10}$/)
        expect(context?.identity.providerClientOrderId).toBe(context?.identity.canonicalOrderId)
        expect(result.result.providerClientOrderId).toBe(context?.identity.canonicalOrderId)
        expect(orderPersistence.upsertOrder).toHaveBeenCalledWith(expect.objectContaining({
            orderId: context?.identity.canonicalOrderId,
            action: "close",
            providerClientOrderId: context?.identity.canonicalOrderId,
        }))
    })

    it("cancels untracked provider working orders with a persisted canonical cancel identity", async () => {
        const cancelOrder = vi.fn(async (orderId: string, context) => ({
            orderId,
            providerOrderId: orderId,
            providerClientOrderId: context?.providerClientOrderId,
            status: "cancelled" as const,
            filledQuantity: 0,
            timestamp: Date.now(),
        }))
        const orderPersistence = {
            upsertOrder: vi.fn(async () => {}),
            logOrderTransition: vi.fn(async () => 1),
            getOrder: vi.fn(async () => null),
            listActiveOrders: vi.fn(async () => []),
        }
        const pipeline = createPipeline({
            venue: {
                ...createVenue(),
                cancelOrder,
            },
            venueName: "mt5",
            orderPersistence,
        })

        const result = await pipeline.cancelOrder("1654528966", "reset flatten")
        const context = cancelOrder.mock.calls[0]?.[1]

        expect(cancelOrder).toHaveBeenCalledWith("1654528966", expect.objectContaining({
            canonicalOrderId: expect.stringMatching(/^vmtx01[a-z2-7]{10}$/),
            providerOrderId: "1654528966",
        }))
        expect(result).toMatchObject({
            canonicalOrderId: context?.canonicalOrderId,
            providerOrderId: "1654528966",
            status: "cancelled",
        })
        expect(orderPersistence.upsertOrder).toHaveBeenCalledWith(expect.objectContaining({
            orderId: context?.canonicalOrderId,
            action: "cancel",
            providerOrderId: "1654528966",
            status: "pending",
        }))
        expect(orderPersistence.upsertOrder).toHaveBeenCalledWith(expect.objectContaining({
            orderId: context?.canonicalOrderId,
            action: "cancel",
            providerOrderId: "1654528966",
            status: "cancelled",
        }))
    })

    it("rejects reused submit attempt sequences for the same logical order", async () => {
        const submitOrder = vi.fn(createVenue().submitOrder)
        const pipeline = createPipeline({
            venue: {
                ...createVenue(),
                submitOrder,
            },
            venueName: "mt5",
        })
        const intent: OrderIntent = {
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "market",
            timeInForce: "gtc",
            metadata: {
                logicalOrderSequence: 7,
                submitAttemptSequence: 1,
            },
        }

        await pipeline.executeIntent(intent, account, [])
        await expect(pipeline.executeIntent(intent, account, [])).rejects.toMatchObject({
            executionError: {
                code: "SUBMIT_ATTEMPT_SEQUENCE_REUSED",
            },
        })
        expect(submitOrder).toHaveBeenCalledTimes(1)
    })

    it("allows a caller-supplied higher submit attempt sequence for the same terminal logical order", async () => {
        const submitOrder = vi.fn(createVenue().submitOrder)
        const pipeline = createPipeline({
            venue: {
                ...createVenue(),
                submitOrder,
            },
            venueName: "mt5",
        })
        const baseIntent: OrderIntent = {
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "market",
            timeInForce: "gtc",
            metadata: {
                logicalOrderSequence: 7,
                submitAttemptSequence: 1,
            },
        }

        const first = await pipeline.executeIntent(baseIntent, account, [])
        const second = await pipeline.executeIntent({
            ...baseIntent,
            metadata: {
                ...baseIntent.metadata,
                submitAttemptSequence: 2,
            },
        }, account, [])

        expect(first.result.canonicalOrderId).toBe(second.result.canonicalOrderId)
        expect(first.result.submitAttemptId).not.toBe(second.result.submitAttemptId)
        expect(second.result.submitAttemptSequence).toBe(2)
        expect(submitOrder).toHaveBeenCalledTimes(2)
    })

    it("rejects a higher submit attempt sequence while the previous canonical order is pending", async () => {
        const submitOrder = vi.fn(async (intent: OrderIntent, context?: SubmitOrderContext) => ({
            orderId: context?.identity.canonicalOrderId ?? "pending-order",
            canonicalOrderId: context?.identity.canonicalOrderId,
            providerClientOrderId: context?.identity.providerClientOrderId,
            submitAttemptId: context?.identity.submitAttemptId,
            submitAttemptSequence: context?.identity.submitAttemptSequence,
            commitOutcome: "accepted" as const,
            status: "pending" as const,
            filledQuantity: 0,
            timestamp: Date.now(),
        }))
        const pipeline = createPipeline({
            venue: {
                ...createVenue(),
                submitOrder,
            },
            venueName: "mt5",
        })
        const baseIntent: OrderIntent = {
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "market",
            timeInForce: "gtc",
            metadata: {
                logicalOrderSequence: 7,
                submitAttemptSequence: 1,
            },
        }

        await pipeline.executeIntent(baseIntent, account, [])
        await expect(pipeline.executeIntent({
            ...baseIntent,
            metadata: {
                ...baseIntent.metadata,
                submitAttemptSequence: 2,
            },
        }, account, [])).rejects.toMatchObject({
            executionError: {
                code: "SUBMIT_ATTEMPT_PREVIOUS_NOT_TERMINAL",
            },
        })
        expect(submitOrder).toHaveBeenCalledTimes(1)
    })

    it("rejects a higher submit attempt sequence when prior terminal truth is missing", async () => {
        const submitOrder = vi.fn(createVenue().submitOrder)
        const pipeline = createPipeline({
            venue: {
                ...createVenue(),
                submitOrder,
            },
            venueName: "mt5",
        })

        await expect(pipeline.executeIntent({
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "market",
            timeInForce: "gtc",
            metadata: {
                logicalOrderSequence: 7,
                submitAttemptSequence: 2,
            },
        }, account, [])).rejects.toMatchObject({
            executionError: {
                code: "SUBMIT_ATTEMPT_PRIOR_ORDER_NOT_FOUND",
            },
        })
        expect(submitOrder).not.toHaveBeenCalled()
    })

    it("blocks a higher submit attempt sequence after unresolved duplicate exposure", async () => {
        const faultRecorder = vi.fn(async () => {})
        const venue = {
            ...createVenue(),
            submitOrder: vi.fn(async () => {
                throw createExecutionError("venue", "IPC recv failed", {
                    code: "IPC_RECV_FAILED",
                    retryable: true,
                })
            }),
            recoverSubmittedOrder: vi.fn(async () => ({
                outcome: "ambiguous" as const,
                message: "multiple MT5 tickets share the canonical comment",
                matches: [
                    {
                        orderId: "1607001000",
                        providerOrderId: "1607001000",
                        status: "pending" as const,
                        filledQuantity: 0,
                        timestamp: Date.now(),
                    },
                    {
                        orderId: "1607001001",
                        providerOrderId: "1607001001",
                        status: "pending" as const,
                        filledQuantity: 0,
                        timestamp: Date.now(),
                    },
                ],
            })),
        }
        const pipeline = createPipeline({
            venue,
            venueName: "mt5",
            executionSafetyFaultRecorder: faultRecorder,
        })
        const baseIntent: OrderIntent = {
            instrument: "XAUUSD",
            side: "buy",
            quantity: 1,
            orderType: "market",
            timeInForce: "gtc",
            metadata: {
                logicalOrderSequence: 7,
                submitAttemptSequence: 1,
            },
        }

        const first = await pipeline.executeIntent(baseIntent, account, [])
        const second = await pipeline.executeIntent({
            ...baseIntent,
            metadata: {
                ...baseIntent.metadata,
                submitAttemptSequence: 2,
            },
        }, account, [])

        expect(first.result.commitOutcome).toBe("commit_unknown")
        expect(faultRecorder).toHaveBeenCalledWith(expect.objectContaining({
            category: "duplicate_exposure",
        }))
        expect(second.validation.allowed).toBe(false)
        expect(second.validation.reason).toContain("unresolved commit-unknown")
        expect(venue.submitOrder).toHaveBeenCalledTimes(1)
    })
})

describe("ExecutionPipeline dry-run accounting", () => {
    it("does not call provider identity preparation for dry-run submissions", async () => {
        const prepareOrderIdentity = vi.fn(async () => {
            throw createExecutionError("pre_validation", "live signing unavailable", {
                code: "LIVE_SIGNING_UNAVAILABLE",
                retryable: false,
            })
        })
        const venue: VenueAdapter = {
            ...createVenue(),
            prepareOrderIdentity,
        }
        const pipeline = createPipeline({
            venue,
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            runId: "run-dry-identity",
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

        expect(result.status).toBe("filled")
        expect(prepareOrderIdentity).not.toHaveBeenCalled()
    })

    it("keeps deterministic cash and realized PnL after closing a virtual position", async () => {
        const tradeLogger = createTradeLogger()
        const pipeline = createPipeline({
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            tradeEventLogger: tradeLogger,
            runId: "run-1",
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
        const pipeline = createPipeline({
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
            runId: "run-2",
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
        const pipeline = createPipeline({
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            runId: "run-3",
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
        const pipeline = createPipeline({
            venueName: "mt5",
            policy: {
                dryRun: true,
                virtualCash: 1000,
            },
            runId: "run-4",
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
        const pipeline = createPipeline({
            venue,
            venueName: "polymarket",
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
            runId: "run-5",
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
        const pipeline = createPipeline({
            venue,
            venueName: "alpaca-options",
            runId: "run-6",
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
        const pipeline = createPipeline({
            venue,
            venueName: "polymarket",
            runId: "run-cost-1",
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
        const pipeline = createPipeline({
            venue,
            venueName: "polymarket",
            runId: "run-cost-2",
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
