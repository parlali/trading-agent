import { describe, expect, it } from "vitest"
import { resolveCloseOrderRealizedPnl } from "@valiq-trading/core"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { buildPositionClosureKey } from "../../convex/lib/mutations/portfolioCloseIdentity"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex provider closure reconciliation safety", () => {
    it("records a blocking unattributed-closure fault when a money-bearing close matches owned positions ambiguously", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-okx"
        const strategyId = "strategy-okx"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "okx-swap",
                accountId,
                name: "OKX ETH",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: "run-okx",
                strategyId,
                app: "okx-swap",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [],
            provider_positions: [
                {
                    _id: "provider-position-a",
                    app: "okx-swap",
                    accountId,
                    positionKey: "ETH-USDT-SWAP:POS1",
                    providerPositionId: "POS1",
                    strategyId,
                    ownershipStatus: "owned",
                    expectedExternal: false,
                    instrument: "ETH-USDT-SWAP",
                    side: "short",
                    quantity: 5,
                    entryPrice: 1893.06,
                    currentPrice: 1877.49,
                    unrealizedPnl: 77.85,
                    metadata: JSON.stringify({ posId: "POS1" }),
                    syncedAt: openedAt,
                },
                {
                    _id: "provider-position-b",
                    app: "okx-swap",
                    accountId,
                    positionKey: "ETH-USDT-SWAP:POS1:duplicate",
                    providerPositionId: "POS1",
                    strategyId,
                    ownershipStatus: "owned",
                    expectedExternal: false,
                    instrument: "ETH-USDT-SWAP",
                    side: "short",
                    quantity: 5,
                    entryPrice: 1893.06,
                    currentPrice: 1877.49,
                    unrealizedPnl: 77.85,
                    metadata: JSON.stringify({ posId: "POS1" }),
                    syncedAt: openedAt,
                },
            ],
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
            app: "okx-swap",
            accountId,
            venue: "okx",
            source: "periodic_sync",
            accountState: {
                balance: 40_000,
                equity: 40_000,
                buyingPower: 20_000,
                marginUsed: 0,
                marginAvailable: 20_000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: "ETH-USDT-SWAP",
                providerPositionId: "POS1",
                side: "short",
                quantity: 5,
                fillPrice: 1880,
                closedAt,
                metadata: JSON.stringify({
                    posId: "POS1",
                    fillPnl: 12.5,
                }),
            }],
        })

        const faults = db.rows.execution_safety_faults ?? []
        const ambiguousFault = faults.find((fault) =>
            fault.category === "unattributed_closure" &&
            fault.blocked === true &&
            fault.strategyId === strategyId &&
            String(fault.message).includes("ambiguous")
        )
        expect(ambiguousFault).toBeDefined()
        expect(ambiguousFault).toMatchObject({
            app: "okx-swap",
            accountId,
            instrument: "ETH-USDT-SWAP",
        })

        const metric = (db.rows.control_plane_metrics ?? []).find((row) =>
            row.metric === "reconcile_provider_portfolio.unattributed_closures"
        )
        expect(metric).toMatchObject({ value: 1 })
    })

    it("never matches or retires a foreign-account order with a colliding providerOrderId", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-a"
        const foreignAccountId = "account-b"
        const strategyId = "strategy-a"
        const foreignStrategyId = "strategy-b"
        const runId = "run-a"
        const foreignRunId = "run-b"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const collidingProviderOrderId = "1672000001"
        const foreignSyntheticOrderId = `provider-close:mt5:US30:999:${closedAt}`
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 Account A",
                policy: { dryRun: false },
            }],
            strategy_runs: [
                {
                    _id: runId,
                    strategyId,
                    app: "mt5",
                    accountId,
                    status: "completed",
                    startedAt: openedAt,
                    endedAt: openedAt + 30_000,
                },
                {
                    _id: foreignRunId,
                    strategyId: foreignStrategyId,
                    app: "mt5",
                    accountId: foreignAccountId,
                    status: "completed",
                    startedAt: openedAt,
                    endedAt: openedAt + 30_000,
                },
            ],
            instrument_claims: [],
            orders: [
                {
                    _id: "order-foreign-synthetic",
                    orderId: foreignSyntheticOrderId,
                    canonicalOrderId: foreignSyntheticOrderId,
                    providerOrderId: collidingProviderOrderId,
                    providerClientOrderId: undefined,
                    providerOrderAliases: [],
                    runId: foreignRunId,
                    strategyId: foreignStrategyId,
                    app: "mt5",
                    accountId: foreignAccountId,
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "close",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50500,
                    submittedAt: closedAt,
                    updatedAt: closedAt,
                    intent: {
                        instrument: "US30",
                        metadata: {
                            fillPnl: 9.99,
                            providerReconciledClose: true,
                            providerPositionId: "999",
                            positionSide: "long",
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
                {
                    _id: "order-canonical-a",
                    orderId: "canonical-a-close",
                    canonicalOrderId: "canonical-a-close",
                    providerOrderId: collidingProviderOrderId,
                    providerClientOrderId: "vmtc01accounta",
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
                            providerPositionId: "1671367552",
                            providerPositionKey: "US30:1671367552",
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
                instrument: "US30",
                providerPositionId: "1671367552",
                side: "long",
                quantity: 0.1,
                fillPrice: 50711.9,
                closedAt,
                metadata: JSON.stringify({
                    ticket: 900100,
                    orderId: Number(collidingProviderOrderId),
                    positionId: 1671367552,
                    fillPnl: 5.28,
                    profit: 5.28,
                }),
            }],
        })

        const orders = db.rows.orders ?? []
        const canonicalClose = orders.find((order) => order.orderId === "canonical-a-close")
        if (!canonicalClose) {
            throw new Error("Expected the reconciled account's canonical close order")
        }
        expect(((canonicalClose.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            fillPnl: 5.28,
            providerReconciledClose: true,
            attachedProviderDealIds: ["900100"],
        })

        const foreignOrder = orders.find((order) => order.orderId === foreignSyntheticOrderId)
        if (!foreignOrder) {
            throw new Error("Expected foreign-account synthetic close order to still exist")
        }
        expect(foreignOrder).toMatchObject({
            accountId: foreignAccountId,
            status: "filled",
            filledQuantity: 0.1,
            canonicalOrderId: foreignSyntheticOrderId,
        })
        const foreignMetadata = (foreignOrder.intent as Record<string, unknown>).metadata as Record<string, unknown>
        expect(foreignMetadata.providerReconciledCloseRetired).toBeUndefined()
        expect(foreignMetadata.fillPnl).toBe(9.99)
        expect((db.rows.order_transitions ?? []).filter((transition) =>
            transition.orderId === foreignSyntheticOrderId
        )).toHaveLength(0)
    })

    it("imports both same-millisecond MT5 deals of one close order and accumulates accounting idempotently", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-mt5"
        const strategyId = "strategy-mt5-multideal"
        const runId = "run-mt5-multideal"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const providerPositionId = "1671367552"
        const closeProviderOrderId = "1672000000"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 Multi Deal",
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
                _id: "order-close-multideal",
                orderId: "canonical-multideal-close",
                canonicalOrderId: "canonical-multideal-close",
                providerOrderId: closeProviderOrderId,
                providerClientOrderId: "vmtc01multideal",
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

        const buildDealClosure = (ticket: number, fillPnl: number) => ({
            instrument: "US30",
            providerPositionId,
            side: "long" as const,
            quantity: 0.05,
            fillPrice: 50711.9,
            closedAt,
            metadata: JSON.stringify({
                ticket,
                orderId: Number(closeProviderOrderId),
                positionId: Number(providerPositionId),
                fillPnl,
                profit: fillPnl,
                commission: -0.5,
                swap: -0.1,
            }),
        })
        const dealOne = buildDealClosure(900001, 3)
        const dealTwo = buildDealClosure(900002, 2)

        expect(buildPositionClosureKey(dealOne)).not.toBe(buildPositionClosureKey(dealTwo))

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
            positionClosures: [dealOne, dealTwo],
        }

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const closeOrder = (db.rows.orders ?? []).find((order) => order.orderId === "canonical-multideal-close")
        if (!closeOrder) {
            throw new Error("Expected canonical multi-deal close order")
        }
        const metadata = (closeOrder.intent as Record<string, unknown>).metadata as Record<string, unknown>
        expect(metadata).toMatchObject({
            providerReconciledClose: true,
            attachedProviderDealIds: ["900001", "900002"],
            fillPnl: 5,
            profit: 5,
            commission: -1,
            swap: -0.2,
        })
        expect(metadata.attachedQuantity).toBeCloseTo(0.1, 10)
        expect(closeOrder).toMatchObject({
            status: "filled",
            filledQuantity: 0.1,
            remainingQuantity: 0,
        })
        expect(resolveCloseOrderRealizedPnl(closeOrder as never)).toBeCloseTo(3.8, 10)

        const orderCountAfterFirstSync = (db.rows.orders ?? []).length
        const transitionCountAfterFirstSync = (db.rows.order_transitions ?? []).length

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        expect(db.rows.orders).toHaveLength(orderCountAfterFirstSync)
        expect(db.rows.order_transitions).toHaveLength(transitionCountAfterFirstSync)

        const closeOrderAfterRerun = (db.rows.orders ?? []).find((order) => order.orderId === "canonical-multideal-close")
        const metadataAfterRerun = (closeOrderAfterRerun?.intent as Record<string, unknown>).metadata as Record<string, unknown>
        expect(metadataAfterRerun).toMatchObject({
            attachedProviderDealIds: ["900001", "900002"],
            fillPnl: 5,
            commission: -1,
            swap: -0.2,
        })
        expect(resolveCloseOrderRealizedPnl(closeOrderAfterRerun as never)).toBeCloseTo(3.8, 10)
    })
})
