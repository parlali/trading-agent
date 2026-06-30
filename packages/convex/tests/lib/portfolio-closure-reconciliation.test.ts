import { describe, expect, it } from "vitest"
import { resolveCloseOrderRealizedPnl } from "@valiq-trading/core"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { buildPositionClosureKey } from "../../convex/lib/mutations/portfolioCloseIdentity"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex provider closure reconciliation safety", () => {
    it("records a blocking unattributed-closure fault when a money-bearing close matches conflicting strategy owners", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-okx"
        const strategyId = "strategy-okx"
        const otherStrategyId = "strategy-okx-other"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const db = new FakeDb({
            strategies: [
                {
                    _id: strategyId,
                    app: "okx-swap",
                    accountId,
                    name: "OKX ETH",
                    policy: { dryRun: false },
                },
                {
                    _id: otherStrategyId,
                    app: "okx-swap",
                    accountId,
                    name: "OKX ETH Other",
                    policy: { dryRun: false },
                },
            ],
            strategy_runs: [
                {
                    _id: "run-okx",
                    strategyId,
                    app: "okx-swap",
                    accountId,
                    status: "completed",
                    startedAt: openedAt,
                    endedAt: openedAt + 30_000,
                },
                {
                    _id: "run-okx-other",
                    strategyId: otherStrategyId,
                    app: "okx-swap",
                    accountId,
                    status: "completed",
                    startedAt: openedAt,
                    endedAt: openedAt + 30_000,
                },
            ],
            instrument_claims: [
                {
                    _id: "claim-okx",
                    strategyId,
                    app: "okx-swap",
                    accountId,
                    instrument: "ETH-USDT-SWAP",
                    source: "order",
                    sourceId: "entry-a",
                    updatedAt: openedAt,
                },
                {
                    _id: "claim-okx-other",
                    strategyId: otherStrategyId,
                    app: "okx-swap",
                    accountId,
                    instrument: "ETH-USDT-SWAP",
                    source: "order",
                    sourceId: "entry-b",
                    updatedAt: openedAt,
                },
            ],
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
                    strategyId: otherStrategyId,
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

    it("coalesces tracked and historic evidence for the same provider position before close attribution", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-mt5"
        const strategyId = "strategy-mt5-usdcad"
        const runId = "run-mt5-usdcad"
        const openedAt = 1_782_759_232_960
        const closedAt = 1_782_759_465_457
        const providerPositionId = "1780837838"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 USDCAD",
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
            instrument_claims: [{
                _id: "claim-mt5-usdcad",
                strategyId,
                app: "mt5",
                accountId,
                instrument: "USDCAD",
                source: "order",
                sourceId: "vmte01rhuhhokmnn",
                updatedAt: openedAt,
            }],
            orders: [{
                _id: "order-mt5-entry",
                orderId: "vmte01rhuhhokmnn",
                canonicalOrderId: "vmte01rhuhhokmnn",
                providerOrderId: providerPositionId,
                providerClientOrderId: "vmte01rhuhhokmnn",
                providerOrderAliases: [providerPositionId],
                runId,
                strategyId,
                app: "mt5",
                accountId,
                venue: "mt5",
                instrument: "USDCAD",
                status: "filled",
                action: "entry",
                quantity: 0.01,
                filledQuantity: 0.01,
                remainingQuantity: 0,
                avgFillPrice: 1.42056,
                submittedAt: openedAt,
                updatedAt: openedAt + 1_000,
                intent: {
                    instrument: "USDCAD",
                    side: "sell",
                    quantity: 0.01,
                    orderType: "market",
                    timeInForce: "day",
                    metadata: {
                        action: "entry",
                        positionId: Number(providerPositionId),
                        providerPositionId,
                        identifier: Number(providerPositionId),
                        estimatedPrice: 1.42056,
                    },
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 5_000,
                    timeoutMs: 120_000,
                    startedAt: openedAt,
                    lastCheckedAt: openedAt + 1_000,
                },
            }],
            provider_positions: [{
                _id: "provider-position-mt5-usdcad",
                app: "mt5",
                accountId,
                positionKey: `USDCAD:${providerPositionId}`,
                providerPositionId,
                strategyId,
                ownershipStatus: "owned",
                expectedExternal: false,
                instrument: "USDCAD",
                side: "short",
                quantity: 0.01,
                entryPrice: 1.42056,
                currentPrice: 1.42038,
                unrealizedPnl: 0.13,
                metadata: JSON.stringify({
                    identifier: Number(providerPositionId),
                    providerPositionId,
                    providerPositionKey: `USDCAD:${providerPositionId}`,
                }),
                syncedAt: openedAt + 120_000,
            }],
            provider_position_history: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
            order_transitions: [],
            trade_events: [],
            order_identity_aliases: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "post_run_sync",
            accountState: {
                balance: 147.1,
                equity: 147.1,
                buyingPower: 147.1,
                marginUsed: 0,
                marginAvailable: 147.1,
                openPnl: 0,
                dayPnl: 0.13,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: "USDCAD",
                providerPositionId,
                side: "short",
                quantity: 0.01,
                fillPrice: 1.42038,
                closedAt,
                metadata: JSON.stringify({
                    ticket: 1435964150,
                    orderId: 1780918633,
                    positionId: Number(providerPositionId),
                    fillPnl: 0.13,
                    profit: 0.13,
                    swap: 0,
                    commission: 0,
                    fee: 0,
                    comment: "vmtc014jvr76relg",
                    providerClientOrderId: "vmtc014jvr76relg",
                    providerAccountingSource: "mt5_deal",
                }),
            }],
        })

        const faults = db.rows.execution_safety_faults ?? []
        expect(faults.filter((fault) => fault.category === "unattributed_closure")).toHaveLength(0)
        const close = (db.rows.orders ?? []).find((order) =>
            String(order.orderId).startsWith(`provider-close:mt5:USDCAD:${providerPositionId}:`)
        )
        if (!close) {
            throw new Error("Expected synthetic MT5 provider close")
        }

        expect(resolveCloseOrderRealizedPnl(close as never)).toBeCloseTo(0.13)
        expect(db.rows.provider_positions ?? []).toHaveLength(0)
        expect(db.rows.provider_position_history ?? []).toHaveLength(1)
        expect(db.rows.provider_sync_state?.[0]).toMatchObject({
            providerStatus: "healthy",
            driftDetected: false,
        })
    })

    it("repairs duplicate stored provider rows for one provider position identity", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-mt5"
        const strategyId = "strategy-mt5-gold"
        const providerPositionId = "1780837838"
        const syncedAt = 1_782_759_232_960
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 Gold",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: "run-mt5-gold",
                strategyId,
                app: "mt5",
                accountId,
                status: "completed",
                startedAt: syncedAt,
                endedAt: syncedAt + 30_000,
            }],
            instrument_claims: [{
                _id: "claim-mt5-gold",
                strategyId,
                app: "mt5",
                accountId,
                instrument: "XAUUSD",
                source: "order",
                sourceId: "vmte01entry",
                updatedAt: syncedAt,
            }],
            orders: [],
            provider_positions: [
                {
                    _id: "provider-position-canonical",
                    app: "mt5",
                    accountId,
                    positionKey: `XAUUSD:${providerPositionId}`,
                    providerPositionId,
                    strategyId,
                    ownershipStatus: "owned",
                    expectedExternal: false,
                    instrument: "XAUUSD",
                    side: "long",
                    quantity: 0.01,
                    entryPrice: 3330,
                    currentPrice: 3331,
                    unrealizedPnl: 1,
                    metadata: JSON.stringify({ providerPositionId }),
                    syncedAt,
                },
                {
                    _id: "provider-position-duplicate",
                    app: "mt5",
                    accountId,
                    positionKey: `XAUUSD:${providerPositionId}:duplicate`,
                    providerPositionId,
                    strategyId,
                    ownershipStatus: "owned",
                    expectedExternal: false,
                    instrument: "XAUUSD",
                    side: "long",
                    quantity: 0.01,
                    entryPrice: 3330,
                    currentPrice: 3331,
                    unrealizedPnl: 1,
                    metadata: JSON.stringify({ providerPositionId }),
                    syncedAt: syncedAt + 1,
                },
            ],
            provider_position_history: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
            order_transitions: [],
            trade_events: [],
            order_identity_aliases: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 1000,
                equity: 1001,
                buyingPower: 1000,
                marginUsed: 1,
                marginAvailable: 999,
                openPnl: 1,
                dayPnl: 0,
            },
            positions: [{
                instrument: "XAUUSD",
                providerPositionId,
                side: "long",
                quantity: 0.01,
                entryPrice: 3330,
                currentPrice: 3331,
                unrealizedPnl: 1,
                metadata: JSON.stringify({ providerPositionId }),
            }],
            workingOrders: [],
            positionClosures: [],
        })

        expect(db.rows.provider_positions).toHaveLength(1)
        expect(db.rows.provider_positions?.[0]).toMatchObject({
            positionKey: `XAUUSD:${providerPositionId}`,
            providerPositionId,
            strategyId,
            ownershipStatus: "owned",
        })
        expect(db.rows.provider_position_history ?? []).toHaveLength(0)
        expect(db.rows.provider_sync_state?.[0]?.lastDriftSummary).toBeUndefined()
        expect(db.rows.provider_sync_state?.[0]).toMatchObject({
            providerStatus: "healthy",
            driftDetected: false,
        })
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

    it("resolves MT5 close orders through indexed aliases without scanning account orders", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-mt5"
        const strategyId = "strategy-mt5-alias"
        const runId = "run-mt5-alias"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const providerPositionId = "1726069249"
        const brokerCloseOrderId = "1727000001"
        const canonicalOrderId = "canonical-alias-close"
        const db = new NoAccountOrderScanFakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId,
                name: "MT5 Alias Close",
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
                _id: "order-close-alias",
                orderId: canonicalOrderId,
                canonicalOrderId,
                providerOrderId: "provider-close-current-id",
                providerClientOrderId: "vmtc01aliasclose",
                providerOrderAliases: [brokerCloseOrderId],
                runId,
                strategyId,
                app: "mt5",
                accountId,
                venue: "mt5",
                instrument: "GBPUSD",
                status: "filled",
                action: "close",
                quantity: 0.01,
                filledQuantity: 0.01,
                remainingQuantity: 0,
                avgFillPrice: 1.271,
                submittedAt: closedAt - 1_000,
                updatedAt: closedAt,
                intent: {
                    instrument: "GBPUSD",
                    metadata: {
                        providerPositionId,
                        providerPositionKey: `GBPUSD:${providerPositionId}`,
                        entryPrice: 1.2705,
                        positionSide: "long",
                    },
                    side: "sell",
                    quantity: 0.01,
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
            order_identity_aliases: [{
                _id: "alias-close-order",
                app: "mt5",
                accountId,
                alias: brokerCloseOrderId,
                orderId: canonicalOrderId,
                orderDocId: "order-close-alias",
                strategyId,
                updatedAt: closedAt,
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [{
                _id: "fault-source-entry-missing-accounting",
                strategyId,
                app: "mt5",
                accountId,
                instrument: "GBPUSD",
                category: "accounting_mismatch",
                message: "Provider accepted a filled entry order without provider accounting metadata",
                providerPayload: JSON.stringify({
                    orderId: "entry-order",
                    providerOrderId: providerPositionId,
                    action: "entry",
                }),
                canonicalOrderId: "entry-order",
                providerOrderId: providerPositionId,
                providerClientOrderId: "entry-order",
                providerOrderAliases: [],
                runId,
                venue: "mt5",
                blocked: true,
                occurredAt: openedAt + 1_000,
                resolvedAt: undefined,
                resolutionNote: undefined,
            }],
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
                instrument: "GBPUSD",
                providerPositionId,
                side: "long",
                quantity: 0.01,
                fillPrice: 1.271,
                closedAt,
                metadata: JSON.stringify({
                    ticket: 910001,
                    orderId: Number(brokerCloseOrderId),
                    positionId: Number(providerPositionId),
                    fillPnl: 1.25,
                    profit: 1.25,
                    swap: 0.05,
                }),
            }],
        })

        const closeOrder = (db.rows.orders ?? []).find((order) => order.orderId === canonicalOrderId)
        if (!closeOrder) {
            throw new Error("Expected canonical alias close order")
        }
        const metadata = (closeOrder.intent as Record<string, unknown>).metadata as Record<string, unknown>
        expect(metadata).toMatchObject({
            providerReconciledClose: true,
            attachedProviderDealIds: ["910001"],
            fillPnl: 1.25,
            swap: 0.05,
        })
        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-source-entry-missing-accounting",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: `Provider closure attached to canonical close order ${canonicalOrderId}`,
        }))
        expect(db.accountOrderScanAttempted).toBe(false)
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

class NoAccountOrderScanFakeDb extends FakeDb {
    accountOrderScanAttempted = false

    override query(table: string) {
        const query = super.query(table)
        if (table !== "orders") {
            return query
        }

        return new Proxy(query, {
            get: (target, property) => {
                if (property === "withIndex") {
                    return (name: string, filter?: Parameters<typeof query.withIndex>[1]) => {
                        if (name === "by_app_account") {
                            this.accountOrderScanAttempted = true
                            throw new Error("orders.by_app_account scan is not allowed in close reconciliation")
                        }

                        return query.withIndex(name, filter)
                    }
                }

                const value = Reflect.get(target, property)
                return typeof value === "function" ? value.bind(target) : value
            },
        })
    }
}
