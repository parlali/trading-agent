import { describe, expect, it } from "vitest"
import { resolveCloseOrderRealizedPnl } from "@valiq-trading/core"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex MT5 provider close replay", () => {
    const accountId = "account-mt5"

    it("repairs a vanished MT5 entry order and imports broker close history after the live provider row is gone", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-mt5"
        const runId = "run-mt5"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 Gold",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "mt5",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-entry",
                orderId: "1671162537",
                canonicalOrderId: "1671162537",
                providerOrderId: "1671162537",
                providerClientOrderId: "vmte01goldclose",
                providerOrderAliases: [],
                runId,
                strategyId,
                app: "mt5",
                accountId,
                venue: "mt5",
                instrument: "XAUUSD",
                status: "cancelled",
                action: "entry",
                quantity: 0.01,
                filledQuantity: 0,
                remainingQuantity: 0.01,
                submittedAt: openedAt,
                updatedAt: openedAt + 1_000,
                intent: {
                    instrument: "XAUUSD",
                    limitPrice: 4434.18,
                    metadata: {
                        estimatedPrice: 4434.18,
                    },
                    side: "sell",
                    quantity: 0.01,
                    orderType: "market",
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 0,
                    timeoutMs: 0,
                    startedAt: openedAt,
                    lastCheckedAt: openedAt + 1_000,
                },
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 813.97,
                equity: 813.97,
                buyingPower: 813.97,
                marginUsed: 0,
                marginAvailable: 813.97,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: "XAUUSD",
                providerPositionId: "1671162537",
                side: "short",
                quantity: 0.01,
                fillPrice: 4457.5,
                closedAt,
                metadata: JSON.stringify({
                    orderId: 1672000000,
                    positionId: 1671162537,
                    fillPnl: -23.32,
                    profit: -23.32,
                }),
            }],
        })

        const orders = db.rows.orders ?? []
        const entryOrder = orders.find((order) => order.orderId === "1671162537")
        expect(entryOrder).toMatchObject({
            status: "filled",
            filledQuantity: 0.01,
            remainingQuantity: 0,
            avgFillPrice: 4434.18,
        })

        const closeOrder = orders.find((order) => order.action === "close")
        if (!closeOrder) {
            throw new Error("Expected MT5 provider-close order")
        }
        expect(closeOrder).toMatchObject({
            orderId: `provider-close:mt5:XAUUSD:1671162537:${closedAt}`,
            providerOrderId: "1672000000",
            runId,
            strategyId,
            instrument: "XAUUSD",
            status: "filled",
            action: "close",
            quantity: 0.01,
            filledQuantity: 0.01,
            avgFillPrice: 4457.5,
        })
        expect(((closeOrder.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            fillPnl: -23.32,
            profit: -23.32,
            providerReconciledClose: true,
            providerPositionId: "1671162537",
            providerPositionKey: "XAUUSD:1671162537",
            entryPrice: 4434.18,
            positionSide: "short",
        })
        expect(resolveCloseOrderRealizedPnl(closeOrder as never)).toBe(-23.32)
        expect(db.rows.order_transitions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                orderId: "1671162537",
                previousStatus: "cancelled",
                status: "filled",
            }),
            expect.objectContaining({
                orderId: `provider-close:mt5:XAUUSD:1671162537:${closedAt}`,
                status: "filled",
            }),
        ]))
    })

    it("attaches MT5 broker close PnL to an existing close order and retires the duplicate synthetic close", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-mt5-us30"
        const runId = "run-mt5-us30"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const providerPositionId = "1671367552"
        const syntheticOrderId = `provider-close:mt5:US30:${providerPositionId}:${closedAt}`
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 US30",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "mt5",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [
                {
                    _id: "order-entry-us30",
                    orderId: providerPositionId,
                    canonicalOrderId: providerPositionId,
                    providerOrderId: providerPositionId,
                    providerClientOrderId: "vmte01us30entry",
                    providerOrderAliases: [],
                    runId,
                    strategyId,
                    app: "mt5",
                    accountId,
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "entry",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50659.1,
                    submittedAt: openedAt,
                    updatedAt: openedAt + 1_000,
                    intent: {
                        instrument: "US30",
                        limitPrice: 50659.1,
                        metadata: {
                            estimatedPrice: 50659.1,
                        },
                        side: "buy",
                        quantity: 0.1,
                        orderType: "market",
                    },
                    lastTransitionSequence: 1,
                    polling: {
                        pollIntervalMs: 0,
                        timeoutMs: 0,
                        startedAt: openedAt,
                        lastCheckedAt: openedAt + 1_000,
                    },
                },
                {
                    _id: "order-close-us30",
                    orderId: "canonical-us30-close",
                    canonicalOrderId: "canonical-us30-close",
                    providerOrderId: "1671600000",
                    providerClientOrderId: "vmtc01us30close",
                    providerOrderAliases: [],
                    runId,
                    strategyId,
                    app: "mt5",
                    accountId,
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "close",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50711.9,
                    submittedAt: closedAt - 1_000,
                    updatedAt: closedAt,
                    intent: {
                        instrument: "US30",
                        metadata: {
                            providerPositionId,
                            providerPositionKey: `US30:${providerPositionId}`,
                            entryPrice: 50659.1,
                            positionSide: "long",
                            estimatedPrice: 50711.9,
                        },
                        side: "sell",
                        quantity: 0.1,
                        orderType: "market",
                    },
                    lastTransitionSequence: 1,
                    polling: {
                        pollIntervalMs: 0,
                        timeoutMs: 0,
                        startedAt: closedAt - 1_000,
                        lastCheckedAt: closedAt,
                    },
                },
                {
                    _id: "order-synthetic-us30",
                    orderId: syntheticOrderId,
                    canonicalOrderId: syntheticOrderId,
                    providerOrderId: "1672000001",
                    providerClientOrderId: undefined,
                    providerOrderAliases: [],
                    runId,
                    strategyId,
                    app: "mt5",
                    accountId,
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "close",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50711.9,
                    submittedAt: closedAt,
                    updatedAt: closedAt,
                    intent: {
                        instrument: "US30",
                        metadata: {
                            fillPnl: 5.28,
                            providerReconciledClose: true,
                            providerPositionId,
                            providerPositionKey: `US30:${providerPositionId}`,
                            entryPrice: 50659.1,
                            positionSide: "long",
                            estimatedPrice: 50711.9,
                        },
                        side: "sell",
                        quantity: 0.1,
                        orderType: "market",
                    },
                    lastTransitionSequence: 1,
                    polling: {
                        pollIntervalMs: 0,
                        timeoutMs: 0,
                        startedAt: closedAt,
                        lastCheckedAt: closedAt,
                    },
                },
            ],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        const reconcileArgs = {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 813.97,
                equity: 813.97,
                buyingPower: 813.97,
                marginUsed: 0,
                marginAvailable: 813.97,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: "US30",
                providerPositionId,
                side: "long",
                quantity: 0.1,
                fillPrice: 50711.9,
                closedAt,
                metadata: JSON.stringify({
                    orderId: 1672000001,
                    positionId: Number(providerPositionId),
                    fillPnl: 5.28,
                    profit: 5.28,
                }),
            }],
        }

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const orders = db.rows.orders ?? []
        const canonicalClose = orders.find((order) => order.orderId === "canonical-us30-close")
        if (!canonicalClose) {
            throw new Error("Expected canonical MT5 close order")
        }
        expect(((canonicalClose.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            fillPnl: 5.28,
            providerReconciledClose: true,
            providerPositionId,
            providerPositionKey: `US30:${providerPositionId}`,
        })
        expect(resolveCloseOrderRealizedPnl(canonicalClose as never)).toBe(5.28)

        const retiredSynthetic = orders.find((order) => order.orderId === syntheticOrderId)
        if (!retiredSynthetic) {
            throw new Error("Expected retired synthetic MT5 close order")
        }
        expect(retiredSynthetic).toMatchObject({
            canonicalOrderId: "canonical-us30-close",
            status: "cancelled",
            filledQuantity: 0,
            remainingQuantity: 0.1,
        })
        expect(((retiredSynthetic.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            providerReconciledCloseRetired: true,
            providerReconciledDuplicateOfOrderId: "canonical-us30-close",
        })
        expect(resolveCloseOrderRealizedPnl(retiredSynthetic as never)).toBeUndefined()

        const transitions = db.rows.order_transitions ?? []
        const orderCountAfterFirstSync = orders.length
        const transitionCountAfterFirstSync = transitions.length

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        expect(db.rows.orders).toHaveLength(orderCountAfterFirstSync)
        expect(db.rows.order_transitions).toHaveLength(transitionCountAfterFirstSync)

        const canonicalCloseAfterRerun = (db.rows.orders ?? []).find((order) => order.orderId === "canonical-us30-close")
        expect(resolveCloseOrderRealizedPnl(canonicalCloseAfterRerun as never)).toBe(5.28)
        const retiredSyntheticAfterRerun = (db.rows.orders ?? []).find((order) => order.orderId === syntheticOrderId)
        expect(retiredSyntheticAfterRerun).toMatchObject({ status: "cancelled" })
        expect(resolveCloseOrderRealizedPnl(retiredSyntheticAfterRerun as never)).toBeUndefined()
    })

    it("clears inferred MT5 entry-fill accounting faults only after a clean provider money audit", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-mt5-us30"
        const runId = "run-mt5-us30"
        const openedAt = 1_779_900_000_000
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 US30",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "mt5",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-us30-inferred-entry",
                orderId: "vmte01yfzuleedki",
                canonicalOrderId: "vmte01yfzuleedki",
                providerOrderId: "1710222012",
                providerClientOrderId: "vmte01yfzuleedki",
                providerOrderAliases: [],
                runId,
                strategyId,
                app: "mt5",
                accountId,
                venue: "mt5",
                instrument: "US30",
                status: "filled",
                action: "entry",
                quantity: 0.1,
                filledQuantity: 0.1,
                remainingQuantity: 0,
                avgFillPrice: 52064.1,
                submittedAt: openedAt,
                updatedAt: openedAt + 1_000,
                intent: {
                    instrument: "US30",
                    limitPrice: 52060,
                    metadata: {
                        providerReconciliationInferredFill: true,
                        providerAccountingBackfillMissing: true,
                    },
                    side: "sell",
                    quantity: 0.1,
                    orderType: "limit",
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 0,
                    timeoutMs: 0,
                    startedAt: openedAt,
                    lastCheckedAt: openedAt + 1_000,
                },
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [
                {
                    _id: "fault-inferred-entry-fill",
                    strategyId,
                    app: "mt5",
                    accountId,
                    instrument: "US30",
                    category: "accounting_mismatch",
                    message: "Provider reconciliation inferred a filled entry order without provider accounting metadata",
                    providerPayload: JSON.stringify({
                        orderId: "vmte01yfzuleedki",
                        providerOrderId: "1710222012",
                        action: "entry",
                    }),
                    canonicalOrderId: "vmte01yfzuleedki",
                    providerOrderId: "1710222012",
                    providerClientOrderId: "vmte01yfzuleedki",
                    providerOrderAliases: [],
                    runId,
                    venue: "mt5",
                    blocked: true,
                    occurredAt: openedAt + 1_000,
                    resolvedAt: undefined,
                    resolutionNote: undefined,
                },
                {
                    _id: "fault-account-money",
                    strategyId,
                    app: "mt5",
                    accountId,
                    instrument: "account",
                    category: "accounting_mismatch",
                    message: "Money-level reconciliation mismatch: mt5 equity delta 3.000000, attributed realized 0.000000, account events 0.000000, open PnL delta -0.430000, residual 3.430000, tolerance 1.000000",
                    providerPayload: JSON.stringify({ residual: 3.43 }),
                    blocked: true,
                    occurredAt: openedAt + 1_000,
                    resolvedAt: undefined,
                    resolutionNote: undefined,
                },
                {
                    _id: "fault-refresh-missing-accounting",
                    strategyId,
                    app: "mt5",
                    accountId,
                    instrument: "US30",
                    category: "accounting_mismatch",
                    message: "Provider reconciliation refreshed a filled working order without provider accounting metadata",
                    providerPayload: JSON.stringify({
                        orderId: "other-order",
                        action: "entry",
                    }),
                    canonicalOrderId: "other-order",
                    providerOrderId: "other-provider-order",
                    blocked: true,
                    occurredAt: openedAt + 1_000,
                    resolvedAt: undefined,
                    resolutionNote: undefined,
                },
            ],
            account_snapshots: [{
                _id: "snapshot-mt5-clean-baseline",
                app: "mt5",
                accountId,
                venue: "mt5",
                balance: 1073.06,
                equity: 1073.06,
                buyingPower: 1073.06,
                marginUsed: 0,
                marginAvailable: 1073.06,
                openPnl: 0,
                dayPnl: 0,
                timestamp: openedAt - 60_000,
            }],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 1073.06,
                equity: 1073.06,
                buyingPower: 1073.06,
                marginUsed: 0,
                marginAvailable: 1073.06,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [],
            accountPnlEvents: [],
        })

        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-inferred-entry-fill",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: "Provider money-level reconciliation audit passed within tolerance after inferred entry fill accounting gap",
        }))
        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-account-money",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: "Provider money-level reconciliation audit passed within tolerance",
        }))
        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-refresh-missing-accounting",
            blocked: true,
            resolvedAt: undefined,
            resolutionNote: undefined,
        }))
        expect(db.rows.alerts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                strategyId,
                severity: "info",
                message: "[execution-safety] Provider money-level reconciliation cleared 1 account fault(s) after a clean audit",
            }),
            expect.objectContaining({
                strategyId,
                severity: "info",
                message: "[execution-safety] Provider money-level reconciliation cleared 1 inferred entry fill accounting fault(s) after a clean audit",
            }),
        ]))
    })

})
