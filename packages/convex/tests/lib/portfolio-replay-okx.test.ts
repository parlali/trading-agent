import { describe, expect, it, vi } from "vitest"
import { resolveCloseOrderRealizedPnl } from "@valiq-trading/core"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex OKX net-mode closure replay", () => {
    const accountId = "account-okx"

    it("attaches OKX fills-history PnL to the canonical close order without creating a duplicate provider close", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-okx-eth"
        const runId = "run-okx-eth"
        const openedAt = 1_780_430_000_000
        const closedAt = openedAt + 657_748
        const providerPositionId = "3618122936764637184"
        const providerOrderId = "3621806927850020864"
        const closeOrderId = "vokc01xwk7pn6xhx"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "okx-swap",
                accountId,
                name: "OKX ETH",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "okx-swap",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-okx-close",
                orderId: closeOrderId,
                canonicalOrderId: closeOrderId,
                providerOrderId: `order:ETH-USDT-SWAP:${providerOrderId}`,
                providerClientOrderId: closeOrderId,
                providerOrderAliases: [providerOrderId],
                runId,
                strategyId,
                app: "okx-swap",
                accountId,
                venue: "okx",
                instrument: "ETH-USDT-SWAP",
                status: "filled",
                action: "close",
                quantity: 5.309,
                filledQuantity: 5.309,
                remainingQuantity: 0,
                avgFillPrice: 1877.49,
                submittedAt: closedAt - 2_000,
                updatedAt: closedAt,
                intent: {
                    instrument: "ETH-USDT-SWAP",
                    metadata: {
                        entryPrice: 1893.0604614805047,
                        posId: providerPositionId,
                        positionMode: "net_mode",
                        positionSide: "short",
                    },
                    side: "buy",
                    quantity: 5.309,
                    orderType: "market",
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 5_000,
                    timeoutMs: 120_000,
                    startedAt: closedAt - 2_000,
                    lastCheckedAt: closedAt,
                },
            }],
            provider_positions: [{
                _id: "provider-position-okx",
                app: "okx-swap",
                accountId,
                positionKey: `ETH-USDT-SWAP:${providerPositionId}`,
                providerPositionId,
                strategyId,
                ownershipStatus: "owned",
                expectedExternal: false,
                instrument: "ETH-USDT-SWAP",
                side: "short",
                quantity: 5.309,
                entryPrice: 1893.0604614805047,
                currentPrice: 1877.49,
                unrealizedPnl: 82.66358,
                metadata: JSON.stringify({
                    posId: providerPositionId,
                    positionMode: "net_mode",
                    contractValue: 0.1,
                    contractValueCurrency: "ETH",
                }),
                syncedAt: openedAt,
            }],
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
                providerPositionId,
                side: "short",
                quantity: 5.309,
                fillPrice: 1877.49,
                closedAt,
                metadata: JSON.stringify({
                    orderId: providerOrderId,
                    fillPnl: 82.66358,
                    fee: -24.918986025,
                    feeCcy: "USDT",
                    source: "okx_fills_history",
                }),
            }],
        })

        const orders = db.rows.orders ?? []
        expect(orders.filter((order) => order.action === "close")).toHaveLength(1)

        const canonicalClose = orders.find((order) => order.orderId === closeOrderId)
        if (!canonicalClose) {
            throw new Error("Expected canonical OKX close order")
        }

        expect(((canonicalClose.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            fillPnl: 82.66358,
            fee: -24.918986025,
            feeCcy: "USDT",
            providerReconciledClose: true,
            providerPositionId,
            providerPositionKey: `ETH-USDT-SWAP:${providerPositionId}`,
            source: "okx_fills_history",
        })
        expect(resolveCloseOrderRealizedPnl(canonicalClose as never)).toBeCloseTo(57.744593975)
        expect(orders.some((order) => String(order.orderId).startsWith("provider-close:okx-swap:"))).toBe(false)
    })

    it("attaches triggered OKX protection child fills to the canonical protection close order", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-okx-protection"
        const runId = "run-okx-protection"
        const openedAt = 1_780_430_000_000
        const closedAt = openedAt + 300_000
        const closeOrderId = "vokt01aaaaaaaaaa"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "okx-swap",
                accountId,
                name: "OKX Protection",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "okx-swap",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-okx-protection",
                orderId: closeOrderId,
                canonicalOrderId: closeOrderId,
                providerOrderId: "algo:ETH-USDT-SWAP:algo-parent-1",
                providerClientOrderId: closeOrderId,
                providerOrderAliases: ["algo-parent-1"],
                runId,
                strategyId,
                app: "okx-swap",
                accountId,
                venue: "okx",
                instrument: "ETH-USDT-SWAP",
                status: "pending",
                action: "close",
                quantity: 2,
                filledQuantity: 0,
                remainingQuantity: 2,
                submittedAt: openedAt,
                updatedAt: openedAt,
                intent: {
                    instrument: "ETH-USDT-SWAP",
                    side: "buy",
                    quantity: 2,
                    orderType: "stop_limit",
                    metadata: {
                        providerProtectionOrder: true,
                    },
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 5_000,
                    timeoutMs: 120_000,
                    startedAt: openedAt,
                    lastCheckedAt: openedAt,
                },
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [{
                _id: "fault-inferred-close",
                strategyId,
                app: "okx-swap",
                accountId,
                instrument: "ETH-USDT-SWAP",
                category: "accounting_mismatch",
                message: "Provider reconciliation inferred a filled close order without provider accounting metadata",
                canonicalOrderId: closeOrderId,
                providerOrderId: "algo:ETH-USDT-SWAP:algo-parent-1",
                blocked: true,
                occurredAt: closedAt,
            }, {
                _id: "fault-unattributed-close",
                strategyId,
                app: "okx-swap",
                accountId,
                instrument: "ETH-USDT-SWAP",
                category: "unattributed_closure",
                message: "Provider reconciliation found an unattributed money-bearing close: ETH-USDT-SWAP:short:2:2026-06-04T20:01:40.000Z (broker close has provider accounting but no canonical order or owned position candidate)",
                providerPayload: JSON.stringify({
                    closure: {
                        instrument: "ETH-USDT-SWAP",
                        side: "short",
                        quantity: 2,
                        fillPrice: 1877.49,
                        closedAt,
                        metadata: JSON.stringify({
                            orderId: "triggered-child-1",
                            triggeredOrderId: "triggered-child-1",
                            algoId: "algo-parent-1",
                            algoClOrdId: closeOrderId,
                            actualOrdId: "triggered-child-1",
                            providerOrderAliases: ["triggered-child-1", "algo-parent-1", closeOrderId],
                            fillPnl: 12.5,
                            fee: -0.25,
                            feeCcy: "USDT",
                            source: "okx_fills_history",
                        }),
                    },
                }),
                blocked: true,
                occurredAt: closedAt,
            }],
            account_snapshots: [],
            account_pnl_events: [],
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
                side: "short",
                quantity: 2,
                fillPrice: 1877.49,
                closedAt,
                metadata: JSON.stringify({
                    orderId: "triggered-child-1",
                    triggeredOrderId: "triggered-child-1",
                    algoId: "algo-parent-1",
                    algoClOrdId: closeOrderId,
                    actualOrdId: "triggered-child-1",
                    providerOrderAliases: ["triggered-child-1", "algo-parent-1", closeOrderId],
                    fillPnl: 12.5,
                    fee: -0.25,
                    feeCcy: "USDT",
                    source: "okx_fills_history",
                }),
            }],
        })

        const orders = db.rows.orders ?? []
        expect(orders.filter((order) => order.action === "close")).toHaveLength(1)
        const canonical = orders.find((order) => order.orderId === closeOrderId)
        expect(canonical).toMatchObject({
            status: "filled",
            filledQuantity: 2,
            remainingQuantity: 0,
            avgFillPrice: 1877.49,
            providerOrderAliases: expect.arrayContaining(["triggered-child-1", "algo-parent-1"]),
        })
        expect(resolveCloseOrderRealizedPnl(canonical as never)).toBeCloseTo(12.25)
        expect(orders.some((order) => String(order.orderId).startsWith("provider-close:"))).toBe(false)
        expect(db.rows.execution_safety_faults ?? []).toEqual([
            expect.objectContaining({
                _id: "fault-inferred-close",
                blocked: false,
                resolutionNote: `Provider closure attached to canonical close order ${closeOrderId}`,
            }),
            expect.objectContaining({
                _id: "fault-unattributed-close",
                blocked: false,
                resolutionNote: `Provider closure attached to canonical close order ${closeOrderId}`,
            }),
        ])
    })

    it("clears stale OKX position-not-found protection faults from replayed canonical provider close evidence", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-okx-btc"
        const runId = "run-okx-btc"
        const openedAt = 1_782_811_155_420
        const closedAt = 1_782_821_024_169
        const providerPositionId = "3699684250355539968"
        const closeOrderId = "vokc01bi6mniiq3r"
        const providerOrderId = "3701678773038260224"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "okx-swap",
                accountId,
                name: "OKX BTC",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "okx-swap",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-okx-btc-close",
                orderId: closeOrderId,
                canonicalOrderId: closeOrderId,
                providerOrderId,
                providerClientOrderId: closeOrderId,
                providerOrderAliases: [
                    "3701678761474293760",
                    providerOrderId,
                    "O3701678772882370560",
                    "vokt03hpcqlhpxw4",
                ],
                runId,
                strategyId,
                app: "okx-swap",
                accountId,
                venue: "okx",
                instrument: "BTC-USDT-SWAP",
                status: "filled",
                action: "close",
                quantity: 0.0484,
                filledQuantity: 0.0484,
                remainingQuantity: 0,
                avgFillPrice: 59148,
                submittedAt: closedAt,
                updatedAt: closedAt,
                intent: {
                    instrument: "BTC-USDT-SWAP",
                    side: "buy",
                    quantity: 0.0484,
                    orderType: "market",
                    metadata: {
                        action: "close",
                        actualOrdId: providerOrderId,
                        algoClOrdId: "vokt03hpcqlhpxw4",
                        algoId: "3701678761474293760",
                        clientOrderId: "O3701678772882370560",
                        entryPrice: 60354.4,
                        estimatedPrice: 59148,
                        fee: -5.308533,
                        feeCcy: "USDT",
                        fillPnl: 8.53579,
                        orderId: providerOrderId,
                        posId: providerPositionId,
                        positionSide: "short",
                        providerPositionId,
                        providerPositionKey: `BTC-USDT-SWAP:${providerPositionId}`,
                        providerReconciledClose: true,
                        side: "buy",
                        source: "okx_fills_history",
                        triggeredOrderId: providerOrderId,
                    },
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 5_000,
                    timeoutMs: 120_000,
                    startedAt: closedAt - 2_000,
                    lastCheckedAt: closedAt,
                },
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [{
                _id: "fault-okx-position-not-found",
                strategyId,
                app: "okx-swap",
                accountId,
                instrument: "BTC-USDT-SWAP",
                category: "position_not_found_yet",
                message: "Protection verification failed: No open OKX swap position found for BTC-USDT-SWAP; flatten_failed=All operations failed (code: 1)",
                providerPayload: JSON.stringify({
                    phase: "verifyProtection",
                    providerPositionKey: `BTC-USDT-SWAP:${providerPositionId}`,
                    providerPositionId,
                    positionSide: "short",
                    intendedStopLoss: 59275,
                    intendedTakeProfit: 59140,
                    verificationError: "No open OKX swap position found for BTC-USDT-SWAP",
                    protectionError: "Protection verification failed: No open OKX swap position found for BTC-USDT-SWAP",
                    flattenError: "All operations failed (code: 1)",
                }),
                canonicalOrderId: "vokm03dp7t5xcszr",
                blocked: true,
                occurredAt: closedAt + 2_000,
            }],
            account_snapshots: [],
            account_pnl_events: [],
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
            positionClosures: [],
        })

        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-okx-position-not-found",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: `Provider closure attached to canonical close order ${closeOrderId}`,
        }))
        expect(db.rows.orders.filter((order) => order.action === "close")).toHaveLength(1)
    })

    it("records a blocking accounting fault when OKX working-order polling fills without provider accounting", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-okx-missing-accounting"
        const runId = "run-okx-missing-accounting"
        const submittedAt = 1_780_430_000_000
        const updatedAt = submittedAt + 60_000
        const orderId = "voke01missingacct"
        const providerOrderId = "9000000000000000003"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "okx-swap",
                accountId,
                name: "OKX Missing Accounting",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "okx-swap",
                accountId,
                status: "completed",
                startedAt: submittedAt,
                endedAt: submittedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-okx-missing-accounting",
                orderId,
                canonicalOrderId: orderId,
                providerOrderId: `order:BTC-USDT-SWAP:${providerOrderId}`,
                providerClientOrderId: orderId,
                providerOrderAliases: [providerOrderId],
                runId,
                strategyId,
                app: "okx-swap",
                accountId,
                venue: "okx",
                instrument: "BTC-USDT-SWAP",
                status: "pending",
                action: "entry",
                quantity: 0.5,
                filledQuantity: 0,
                remainingQuantity: 0.5,
                submittedAt,
                updatedAt: submittedAt,
                intent: {
                    instrument: "BTC-USDT-SWAP",
                    side: "buy",
                    quantity: 0.5,
                    orderType: "market",
                    metadata: {
                        action: "entry",
                    },
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 5_000,
                    timeoutMs: 120_000,
                    startedAt: submittedAt,
                    lastCheckedAt: submittedAt,
                },
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            account_pnl_events: [],
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
            workingOrders: [{
                orderId: `order:BTC-USDT-SWAP:${providerOrderId}`,
                providerOrderId: `order:BTC-USDT-SWAP:${providerOrderId}`,
                providerClientOrderId: orderId,
                providerOrderAliases: [providerOrderId, orderId],
                instrument: "BTC-USDT-SWAP",
                status: "filled",
                quantity: 0.5,
                filledQuantity: 0.5,
                remainingQuantity: 0,
                submittedAt,
                updatedAt,
                side: "buy",
                avgFillPrice: 78000.125,
                metadata: JSON.stringify({
                    providerAccountingSource: "okx_order",
                    providerAccountingMissing: true,
                    providerAccountingMissingReason: "okx_order_fee_and_pnl_unparseable",
                    providerOrderId,
                    providerClientOrderId: orderId,
                    tradeId: "7000000003",
                }),
            }],
            positionClosures: [],
            accountPnlEvents: [],
        })

        const canonical = (db.rows.orders ?? []).find((order) => order.orderId === orderId)
        expect(canonical).toMatchObject({
            status: "filled",
            filledQuantity: 0.5,
            remainingQuantity: 0,
            avgFillPrice: 78000.125,
        })
        expect(((canonical?.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            providerAccountingSource: "okx_order",
            providerAccountingMissing: true,
            providerAccountingMissingReason: "okx_order_fee_and_pnl_unparseable",
            providerOrderId,
            providerClientOrderId: orderId,
            tradeId: "7000000003",
        })
        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            strategyId,
            accountId,
            instrument: "BTC-USDT-SWAP",
            category: "accounting_mismatch",
            canonicalOrderId: orderId,
            providerOrderId: `order:BTC-USDT-SWAP:${providerOrderId}`,
            blocked: true,
            message: "Provider reconciliation refreshed a filled working order without provider accounting metadata",
        }))
    })

    const SHARED_POS_ID = "3618122936764637184"
    const OPENED_AT = 1_780_430_000_000
    const CLOSED_AT = OPENED_AT + 600_000

    function buildOkxStrategy(id: string, name: string) {
        return {
            _id: id,
            app: "okx-swap",
            accountId,
            name,
            policy: { dryRun: false },
        }
    }

    function buildOkxRun(id: string, strategyId: string) {
        return {
            _id: id,
            strategyId,
            app: "okx-swap",
            accountId,
            status: "completed",
            startedAt: OPENED_AT,
            endedAt: OPENED_AT + 30_000,
        }
    }

    function buildCanonicalCloseOrder(args: {
        id: string
        orderId: string
        ordId: string
        runId: string
        strategyId: string
        quantity: number
        fillPrice: number
    }) {
        return {
            _id: args.id,
            orderId: args.orderId,
            canonicalOrderId: args.orderId,
            providerOrderId: `order:ETH-USDT-SWAP:${args.ordId}`,
            providerClientOrderId: args.orderId,
            providerOrderAliases: [args.ordId],
            runId: args.runId,
            strategyId: args.strategyId,
            app: "okx-swap",
            accountId,
            venue: "okx",
            instrument: "ETH-USDT-SWAP",
            status: "filled",
            action: "close",
            quantity: args.quantity,
            filledQuantity: args.quantity,
            remainingQuantity: 0,
            avgFillPrice: args.fillPrice,
            submittedAt: CLOSED_AT - 2_000,
            updatedAt: CLOSED_AT,
            intent: {
                instrument: "ETH-USDT-SWAP",
                metadata: {
                    posId: SHARED_POS_ID,
                    positionMode: "net_mode",
                    positionSide: "short",
                },
                side: "buy",
                quantity: args.quantity,
                orderType: "market",
            },
            lastTransitionSequence: 1,
            polling: {
                pollIntervalMs: 5_000,
                timeoutMs: 120_000,
                startedAt: CLOSED_AT - 2_000,
                lastCheckedAt: CLOSED_AT,
            },
        }
    }

    function buildOwnedProviderPosition(args: {
        id: string
        strategyId: string
        posId: string
        quantity: number
    }) {
        return {
            _id: args.id,
            app: "okx-swap",
            accountId,
            positionKey: `ETH-USDT-SWAP:${args.posId}`,
            providerPositionId: args.posId,
            strategyId: args.strategyId,
            ownershipStatus: "owned",
            expectedExternal: false,
            instrument: "ETH-USDT-SWAP",
            side: "short",
            quantity: args.quantity,
            entryPrice: 1893.06,
            currentPrice: 1877.49,
            unrealizedPnl: 50,
            metadata: JSON.stringify({
                posId: args.posId,
                positionMode: "net_mode",
            }),
            syncedAt: OPENED_AT,
        }
    }

    function buildReconcileArgs(positionClosures: Array<Record<string, unknown>>) {
        return {
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
            positionClosures,
        }
    }

    function buildClosure(args: {
        quantity: number
        fillPrice: number
        fillPnl: number
        providerPositionId?: string
        ordId?: string
        clientOrderId?: string
        closedAt?: number
    }) {
        return {
            instrument: "ETH-USDT-SWAP",
            providerPositionId: args.providerPositionId,
            side: "short",
            quantity: args.quantity,
            fillPrice: args.fillPrice,
            closedAt: args.closedAt ?? CLOSED_AT,
            metadata: JSON.stringify({
                orderId: args.ordId,
                clientOrderId: args.clientOrderId,
                posId: args.providerPositionId,
                fillPnl: args.fillPnl,
                posSide: "net",
                source: "okx_fills_history",
            }),
        }
    }

    it("cancels a missing OKX protection close while the same-side position is still live", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const closeOrderId = "vokt01staleprotect"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [{
                ...buildCanonicalCloseOrder({
                    id: "order-stale-protection",
                    orderId: closeOrderId,
                    ordId: "algo-parent-stale",
                    runId: "run-okx-a",
                    strategyId: "strategy-okx-a",
                    quantity: 5,
                    fillPrice: 1877.49,
                }),
                providerOrderId: "algo:ETH-USDT-SWAP:algo-parent-stale",
                providerOrderAliases: ["algo-parent-stale"],
                status: "pending",
                filledQuantity: 0,
                remainingQuantity: 5,
                avgFillPrice: undefined,
                intent: {
                    instrument: "ETH-USDT-SWAP",
                    side: "buy",
                    quantity: 5,
                    orderType: "stop_limit",
                    metadata: {
                        providerProtectionOrder: true,
                        protectionOrderType: "oco",
                        providerMetadata: {
                            algoId: "algo-parent-stale",
                            providerClientOrderId: closeOrderId,
                            kind: "protection",
                        },
                    },
                },
            }],
            provider_positions: [
                buildOwnedProviderPosition({
                    id: "provider-position-okx",
                    strategyId: "strategy-okx-a",
                    posId: SHARED_POS_ID,
                    quantity: 5,
                }),
            ],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [{
                _id: "fault-stale-inferred-close",
                strategyId: "strategy-okx-a",
                app: "okx-swap",
                accountId,
                instrument: "ETH-USDT-SWAP",
                category: "accounting_mismatch",
                message: "Provider reconciliation inferred a filled close order without provider accounting metadata",
                canonicalOrderId: closeOrderId,
                providerOrderId: "algo:ETH-USDT-SWAP:algo-parent-stale",
                providerClientOrderId: closeOrderId,
                providerOrderAliases: ["algo-parent-stale"],
                blocked: true,
                occurredAt: CLOSED_AT - 30_000,
            }],
            account_snapshots: [],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            positions: [{
                instrument: "ETH-USDT-SWAP",
                providerPositionId: SHARED_POS_ID,
                side: "short",
                quantity: 5,
                entryPrice: 1893.06,
                currentPrice: 1877.49,
                unrealizedPnl: 50,
                metadata: JSON.stringify({
                    posId: SHARED_POS_ID,
                    positionMode: "net_mode",
                }),
            }],
        })

        const closeOrder = db.rows.orders.find((order) => order.orderId === closeOrderId)
        expect(closeOrder).toMatchObject({
            status: "cancelled",
            filledQuantity: 0,
            remainingQuantity: 5,
        })
        expect((closeOrder?.intent as Record<string, unknown>).metadata).not.toMatchObject({
            providerReconciliationInferredFill: true,
        })
        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-stale-inferred-close",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: `Provider reconciliation proved order ${closeOrderId} cancelled unfilled`,
        }))
    })

    it("clears stale inferred-fill faults for OKX closes already proven cancelled unfilled", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const closeOrderId = "vokt01cancelledold"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [{
                ...buildCanonicalCloseOrder({
                    id: "order-cancelled-protection",
                    orderId: closeOrderId,
                    ordId: "algo-parent-cancelled",
                    runId: "run-okx-a",
                    strategyId: "strategy-okx-a",
                    quantity: 5,
                    fillPrice: 1877.49,
                }),
                providerOrderId: "algo:ETH-USDT-SWAP:algo-parent-cancelled",
                providerOrderAliases: ["algo-parent-cancelled"],
                status: "cancelled",
                filledQuantity: 0,
                remainingQuantity: 5,
                avgFillPrice: undefined,
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [{
                _id: "fault-cancelled-inferred-close",
                strategyId: "strategy-okx-a",
                app: "okx-swap",
                accountId,
                instrument: "ETH-USDT-SWAP",
                category: "accounting_mismatch",
                message: "Provider reconciliation inferred a filled close order without provider accounting metadata",
                canonicalOrderId: closeOrderId,
                providerOrderId: "algo:ETH-USDT-SWAP:algo-parent-cancelled",
                providerClientOrderId: closeOrderId,
                providerOrderAliases: ["algo-parent-cancelled"],
                blocked: true,
                occurredAt: CLOSED_AT - 30_000,
            }],
            account_snapshots: [],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([]))

        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            _id: "fault-cancelled-inferred-close",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: `Provider reconciliation proved canonical order ${closeOrderId} cancelled unfilled`,
        }))
    })

    it("promotes a wrongly inferred cancelled canonical close to filled when broker closure truth arrives", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [{
                ...buildCanonicalCloseOrder({
                    id: "order-close-a",
                    orderId: "vokc01aaaaaaaaaa",
                    ordId: "3621806927850020001",
                    runId: "run-okx-a",
                    strategyId: "strategy-okx-a",
                    quantity: 2,
                    fillPrice: 1877.49,
                }),
                status: "cancelled",
                filledQuantity: 0,
                remainingQuantity: 2,
                avgFillPrice: undefined,
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
        const reconcileArgs = buildReconcileArgs([
            buildClosure({
                quantity: 2,
                fillPrice: 1877.49,
                fillPnl: 31.14,
                ordId: "3621806927850020001",
            }),
        ])

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const closeOrder = (db.rows.orders ?? []).find((order) => order.orderId === "vokc01aaaaaaaaaa")
        expect(closeOrder).toMatchObject({
            status: "filled",
            filledQuantity: 2,
            remainingQuantity: 0,
            avgFillPrice: 1877.49,
        })
        expect(resolveCloseOrderRealizedPnl(closeOrder as never)).toBeCloseTo(31.14)

        const promotion = (db.rows.order_transitions ?? []).find((transition) =>
            transition.orderId === "vokc01aaaaaaaaaa" && transition.type === "terminal"
        )
        expect(promotion).toMatchObject({
            status: "filled",
            previousStatus: "cancelled",
        })

        const orderCount = (db.rows.orders ?? []).length
        const transitionCount = (db.rows.order_transitions ?? []).length

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        expect(db.rows.orders).toHaveLength(orderCount)
        expect(db.rows.order_transitions ?? []).toHaveLength(transitionCount)
        expect((db.rows.orders ?? []).find((order) => order.orderId === "vokc01aaaaaaaaaa")).toMatchObject({
            status: "filled",
            filledQuantity: 2,
        })
    })

    it("attributes broker closes to the correct strategy-owned close orders when the net-mode position id is shared", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [
                buildOkxStrategy("strategy-okx-a", "OKX A"),
                buildOkxStrategy("strategy-okx-b", "OKX B"),
            ],
            strategy_runs: [
                buildOkxRun("run-okx-a", "strategy-okx-a"),
                buildOkxRun("run-okx-b", "strategy-okx-b"),
            ],
            instrument_claims: [],
            orders: [
                buildCanonicalCloseOrder({
                    id: "order-close-a",
                    orderId: "vokc01aaaaaaaaaa",
                    ordId: "3621806927850020001",
                    runId: "run-okx-a",
                    strategyId: "strategy-okx-a",
                    quantity: 2,
                    fillPrice: 1877.49,
                }),
                buildCanonicalCloseOrder({
                    id: "order-close-b",
                    orderId: "vokc01bbbbbbbbbb",
                    ordId: "3621806927850020002",
                    runId: "run-okx-b",
                    strategyId: "strategy-okx-b",
                    quantity: 2,
                    fillPrice: 1875.1,
                }),
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
        const reconcileArgs = buildReconcileArgs([
            buildClosure({
                quantity: 2,
                fillPrice: 1877.49,
                fillPnl: 31.14,
                ordId: "3621806927850020001",
                clientOrderId: "vokc01aaaaaaaaaa",
            }),
            buildClosure({
                quantity: 2,
                fillPrice: 1875.1,
                fillPnl: 35.92,
                ordId: "3621806927850020002",
            }),
        ])

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const orders = db.rows.orders ?? []
        expect(orders).toHaveLength(2)
        expect(orders.some((order) => String(order.orderId).startsWith("provider-close:"))).toBe(false)

        const closeA = orders.find((order) => order.orderId === "vokc01aaaaaaaaaa")
        const closeB = orders.find((order) => order.orderId === "vokc01bbbbbbbbbb")
        expect(resolveCloseOrderRealizedPnl(closeA as never)).toBeCloseTo(31.14)
        expect(resolveCloseOrderRealizedPnl(closeB as never)).toBeCloseTo(35.92)

        const orderCount = orders.length
        const transitionCount = (db.rows.order_transitions ?? []).length

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const ordersAfterRerun = db.rows.orders ?? []
        expect(ordersAfterRerun).toHaveLength(orderCount)
        expect(db.rows.order_transitions ?? []).toHaveLength(transitionCount)

        const closeAAfterRerun = ordersAfterRerun.find((order) => order.orderId === "vokc01aaaaaaaaaa")
        const closeBAfterRerun = ordersAfterRerun.find((order) => order.orderId === "vokc01bbbbbbbbbb")
        expect(resolveCloseOrderRealizedPnl(closeAAfterRerun as never)).toBeCloseTo(31.14)
        expect(resolveCloseOrderRealizedPnl(closeBAfterRerun as never)).toBeCloseTo(35.92)
        expect(closeAAfterRerun).toMatchObject({ status: "filled", strategyId: "strategy-okx-a" })
        expect(closeBAfterRerun).toMatchObject({ status: "filled", strategyId: "strategy-okx-b" })
    })

    it("imports an external net-mode broker close as a synthetic provider close exactly once", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [
                buildOwnedProviderPosition({
                    id: "provider-position-okx",
                    strategyId: "strategy-okx-a",
                    posId: SHARED_POS_ID,
                    quantity: 5,
                }),
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
        const reconcileArgs = buildReconcileArgs([
            buildClosure({
                quantity: 5,
                fillPrice: 1877.49,
                fillPnl: -20.1,
                providerPositionId: SHARED_POS_ID,
                ordId: "3621806927859999999",
            }),
        ])

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const syntheticOrderId = `provider-close:okx-swap:ETH-USDT-SWAP:${SHARED_POS_ID}:${CLOSED_AT}`
        const syntheticClose = (db.rows.orders ?? []).find((order) => order.orderId === syntheticOrderId)
        if (!syntheticClose) {
            throw new Error("Expected synthetic provider close order")
        }
        expect(syntheticClose).toMatchObject({
            strategyId: "strategy-okx-a",
            status: "filled",
            action: "close",
            filledQuantity: 5,
            avgFillPrice: 1877.49,
        })
        expect(resolveCloseOrderRealizedPnl(syntheticClose as never)).toBeCloseTo(-20.1)

        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(false)

        const orderCount = (db.rows.orders ?? []).length
        const transitionCount = (db.rows.order_transitions ?? []).length
        const tradeEventCount = (db.rows.trade_events ?? []).length

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        expect(db.rows.orders).toHaveLength(orderCount)
        expect(db.rows.order_transitions ?? []).toHaveLength(transitionCount)
        expect(db.rows.trade_events ?? []).toHaveLength(tradeEventCount)

        const syntheticAfterRerun = (db.rows.orders ?? []).find((order) => order.orderId === syntheticOrderId)
        expect(syntheticAfterRerun).toMatchObject({
            strategyId: "strategy-okx-a",
            status: "filled",
            filledQuantity: 5,
        })
        expect(resolveCloseOrderRealizedPnl(syntheticAfterRerun as never)).toBeCloseTo(-20.1)
    })

    it("attributes late OKX close evidence to a recently disappeared owned position", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const providerPositionId = "3618122936764630001"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [
                buildOwnedProviderPosition({
                    id: "provider-position-late",
                    strategyId: "strategy-okx-a",
                    posId: providerPositionId,
                    quantity: 5,
                }),
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

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([]))

        expect(db.rows.provider_positions ?? []).toHaveLength(0)
        expect(db.rows.provider_position_history).toEqual([
            expect.objectContaining({
                positionKey: `ETH-USDT-SWAP:${providerPositionId}`,
                strategyId: "strategy-okx-a",
                ownershipStatus: "owned",
            }),
        ])
        expect((db.rows.provider_sync_state ?? [])[0]).toMatchObject({
            driftDetected: true,
        })

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([
            buildClosure({
                quantity: 5,
                fillPrice: 1877.49,
                fillPnl: 0,
                ordId: "3621806927858888888",
            }),
        ]))

        const syntheticOrderId = `provider-close:okx-swap:ETH-USDT-SWAP:${providerPositionId}:${CLOSED_AT}`
        const syntheticClose = (db.rows.orders ?? []).find((order) => order.orderId === syntheticOrderId)
        expect(syntheticClose).toMatchObject({
            strategyId: "strategy-okx-a",
            status: "filled",
            action: "close",
            filledQuantity: 5,
            avgFillPrice: 1877.49,
        })
        expect(resolveCloseOrderRealizedPnl(syntheticClose as never)).toBeCloseTo(0)

        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState).toMatchObject({
            driftDetected: false,
            lastDriftSummary: undefined,
        })
        expect(db.rows.execution_safety_faults ?? []).toEqual([])
    })

    it("fails closed when OKX close evidence has no safe owned position candidate", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
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

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([{
            instrument: "ETH-USDT-SWAP",
            side: "short",
            quantity: 5,
            fillPrice: 1877.49,
            closedAt: CLOSED_AT,
            metadata: JSON.stringify({
                orderId: "3621806927857777777",
                tradeIds: ["trade-no-owner"],
                fillPnl: 0,
                fee: -0.12,
                feeCcy: "USDT",
                source: "okx_fills_history",
            }),
        }]))

        expect(db.rows.orders ?? []).toHaveLength(0)
        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(true)
        expect(String(syncState?.lastDriftSummary)).toContain("broker close has provider accounting")
        expect(db.rows.execution_safety_faults ?? []).toEqual([
            expect.objectContaining({
                strategyId: "strategy-okx-a",
                category: "unattributed_closure",
                blocked: true,
            }),
        ])
    })

    it("fails closed instead of quantity-matching a broker close without provider position identity", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [
                buildOwnedProviderPosition({
                    id: "provider-position-a",
                    strategyId: "strategy-okx-a",
                    posId: "3618122936764630001",
                    quantity: 5,
                }),
                buildOwnedProviderPosition({
                    id: "provider-position-b",
                    strategyId: "strategy-okx-a",
                    posId: "3618122936764630002",
                    quantity: 5,
                }),
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

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([
            buildClosure({
                quantity: 5,
                fillPrice: 1877.49,
                fillPnl: 12,
                ordId: "3621806927858888888",
            }),
        ]))

        const orders = db.rows.orders ?? []
        expect(orders).toHaveLength(0)

        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(true)
        expect(String(syncState?.lastDriftSummary)).toContain("broker close has provider accounting")
        expect(String(syncState?.lastDriftSummary)).toContain("ambiguous")

        const driftAlert = (db.rows.alerts ?? []).find((alert) =>
            String(alert.message).includes("broker close has provider accounting")
        )
        expect(driftAlert).toBeDefined()
        expect(db.rows.execution_safety_faults ?? []).toEqual([
            expect.objectContaining({
                strategyId: "strategy-okx-a",
                category: "unattributed_closure",
                blocked: true,
            }),
        ])
    })

    it("records an execution safety fault when a money-bearing close has no order or candidate", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([
            buildClosure({
                quantity: 5,
                fillPrice: 1877.49,
                fillPnl: 12,
                ordId: "unmatched-close-order",
            }),
        ]))

        expect(db.rows.orders ?? []).toHaveLength(0)
        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(true)
        expect(String(syncState?.lastDriftSummary)).toContain("broker close has provider accounting")

        const fault = (db.rows.execution_safety_faults ?? [])[0]
        expect(fault).toMatchObject({
            strategyId: "strategy-okx-a",
            app: "okx-swap",
            accountId,
            instrument: "ETH-USDT-SWAP",
            category: "unattributed_closure",
            blocked: true,
        })

        const metric = (db.rows.control_plane_metrics ?? []).find((row) =>
            row.metric === "reconcile_provider_portfolio.unattributed_closures"
        )
        expect(metric?.value).toBe(1)
    })

    it("persists OKX account PnL events and uses them in money-level reconciliation", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [{
                _id: "snapshot-before",
                app: "okx-swap",
                accountId,
                venue: "okx",
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
                timestamp: CLOSED_AT - 60_000,
            }],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        vi.useFakeTimers()
        vi.setSystemTime(CLOSED_AT)
        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            accountState: {
                balance: 9_998.77,
                equity: 9_998.77,
                buyingPower: 9_998.77,
                marginUsed: 0,
                marginAvailable: 9_998.77,
                openPnl: 0,
                dayPnl: -1.23,
            },
            accountPnlEvents: [{
                providerEventId: "funding-bill-1",
                eventType: "funding_fee",
                instrument: "BTC-USDT-SWAP",
                amount: -1.23,
                currency: "USDT",
                occurredAt: CLOSED_AT,
                metadata: JSON.stringify({
                    source: "okx_account_bills",
                }),
            }],
        })

        expect(db.rows.account_pnl_events).toHaveLength(1)
        expect(db.rows.alerts ?? []).toHaveLength(0)
        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(false)

        vi.setSystemTime(CLOSED_AT + 60_000)
        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            accountState: {
                balance: 9_990,
                equity: 9_990,
                buyingPower: 9_990,
                marginUsed: 0,
                marginAvailable: 9_990,
                openPnl: 0,
                dayPnl: -10,
            },
            accountPnlEvents: [],
        })

        const mismatchState = (db.rows.provider_sync_state ?? [])[0]
        expect(mismatchState?.driftDetected).toBe(true)
        expect(String(mismatchState?.lastDriftSummary)).toContain("account money reconciliation mismatch")
        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            strategyId: "strategy-okx-a",
            app: "okx-swap",
            accountId,
            instrument: "account",
            category: "accounting_mismatch",
            blocked: true,
            message: expect.stringContaining("Money-level reconciliation mismatch"),
        }))

        vi.setSystemTime(CLOSED_AT + 120_000)
        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            accountState: {
                balance: 9_990,
                equity: 9_990,
                buyingPower: 9_990,
                marginUsed: 0,
                marginAvailable: 9_990,
                openPnl: 0,
                dayPnl: -10,
            },
            accountPnlEvents: [],
        })

        expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
            strategyId: "strategy-okx-a",
            app: "okx-swap",
            accountId,
            instrument: "account",
            category: "accounting_mismatch",
            blocked: false,
            resolvedAt: expect.any(Number),
            resolutionNote: "Provider money-level reconciliation audit passed within tolerance",
        }))
        vi.useRealTimers()
    })

    it("excludes account PnL events outside the snapshot window from money-level reconciliation", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [{
                _id: "snapshot-before",
                app: "okx-swap",
                accountId,
                venue: "okx",
                balance: 9_998.77,
                equity: 9_998.77,
                buyingPower: 9_998.77,
                marginUsed: 0,
                marginAvailable: 9_998.77,
                openPnl: 0,
                dayPnl: 0,
                timestamp: CLOSED_AT - 60_000,
            }],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            accountState: {
                balance: 9_998.77,
                equity: 9_998.77,
                buyingPower: 9_998.77,
                marginUsed: 0,
                marginAvailable: 9_998.77,
                openPnl: 0,
                dayPnl: 0,
            },
            accountPnlEvents: [{
                providerEventId: "funding-bill-stale",
                eventType: "funding_fee",
                instrument: "BTC-USDT-SWAP",
                amount: -1.23,
                currency: "USDT",
                occurredAt: CLOSED_AT - 120_000,
                metadata: JSON.stringify({
                    source: "okx_account_bills",
                }),
            }],
        })

        expect(db.rows.account_pnl_events).toHaveLength(1)
        expect(db.rows.alerts ?? []).toHaveLength(0)
        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(false)
    })

    it("patches corrected provider PnL events instead of keeping stale accounting", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            account_pnl_events: [{
                _id: "stale-pnl-event",
                app: "okx-swap",
                accountId,
                venue: "okx",
                providerEventId: "funding-bill-corrected",
                eventType: "funding_fee",
                instrument: "BTC-USDT-SWAP",
                amount: -1,
                currency: "USDT",
                occurredAt: CLOSED_AT - 1_000,
                metadata: JSON.stringify({ revision: 1 }),
                syncedAt: CLOSED_AT - 1_000,
            }],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            accountPnlEvents: [{
                providerEventId: "funding-bill-corrected",
                eventType: "funding_fee",
                instrument: "BTC-USDT-SWAP",
                amount: -1.23,
                currency: "USDT",
                occurredAt: CLOSED_AT,
                metadata: JSON.stringify({ revision: 2 }),
            }],
        })

        expect(db.rows.account_pnl_events).toHaveLength(1)
        expect(db.rows.account_pnl_events[0]).toMatchObject({
            providerEventId: "funding-bill-corrected",
            amount: -1.23,
            occurredAt: CLOSED_AT,
            metadata: JSON.stringify({ revision: 2 }),
        })
        expect(db.rows.control_plane_metrics).toContainEqual(expect.objectContaining({
            metric: "reconcile_provider_portfolio.account_pnl_events_patched",
            value: 1,
        }))
    })

    it("uses provider accounting occurrence time for resting orders filled after the previous snapshot", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const oldCloseOrder = buildCanonicalCloseOrder({
            id: "order-old-close",
            orderId: "vokc01oldclose",
            ordId: "old-provider-close",
            runId: "run-okx-a",
            strategyId: "strategy-okx-a",
            quantity: 1,
            fillPrice: 1877.49,
        })

        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [{
                ...oldCloseOrder,
                updatedAt: CLOSED_AT + 2_000,
                intent: {
                    ...oldCloseOrder.intent,
                    metadata: {
                        ...(oldCloseOrder.intent.metadata as Record<string, unknown>),
                        fillPnl: 25,
                        providerAccountingSource: "okx_order",
                        providerAccountingOccurredAt: CLOSED_AT,
                    },
                },
            }],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [{
                _id: "snapshot-after-close",
                app: "okx-swap",
                accountId,
                venue: "okx",
                balance: 40_000,
                equity: 40_000,
                buyingPower: 20_000,
                marginUsed: 0,
                marginAvailable: 20_000,
                openPnl: 0,
                dayPnl: 0,
                timestamp: CLOSED_AT - 1_000,
            }],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            ...buildReconcileArgs([]),
            accountState: {
                balance: 40_025,
                equity: 40_025,
                buyingPower: 20_025,
                marginUsed: 0,
                marginAvailable: 20_025,
                openPnl: 0,
                dayPnl: 25,
            },
        })

        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(false)
        expect(db.rows.alerts ?? []).toHaveLength(0)
    })

    it("clears retained OKX drift when an audited canonical close lacks provider position identity", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const closeOrder = buildCanonicalCloseOrder({
            id: "order-close-without-pos-id",
            orderId: "vokc01closewithout",
            ordId: "3621806927850020005",
            runId: "run-okx-a",
            strategyId: "strategy-okx-a",
            quantity: 5,
            fillPrice: 1877.49,
        })
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [{
                ...closeOrder,
                intent: {
                    ...closeOrder.intent,
                    metadata: {
                        orderId: "3621806927850020005",
                        clientOrderId: "vokc01closewithout",
                        tradeIds: ["trade-close-without-pos-id"],
                        source: "okx_fills_history",
                        providerReconciledClose: true,
                        positionSide: "short",
                        fillPnl: -14.4,
                        fee: -4.2,
                    },
                },
            }],
            provider_positions: [],
            provider_position_history: [{
                _id: "provider-position-history-okx",
                app: "okx-swap",
                accountId,
                positionKey: `ETH-USDT-SWAP:${SHARED_POS_ID}`,
                providerPositionId: SHARED_POS_ID,
                strategyId: "strategy-okx-a",
                ownershipStatus: "owned",
                expectedExternal: false,
                instrument: "ETH-USDT-SWAP",
                side: "short",
                quantity: 5,
                entryPrice: 1893.06,
                currentPrice: 1877.49,
                unrealizedPnl: 50,
                metadata: JSON.stringify({
                    posId: SHARED_POS_ID,
                    positionMode: "net_mode",
                }),
                lastSeenAt: OPENED_AT,
                disappearedAt: CLOSED_AT - 30_000,
                retainedUntil: CLOSED_AT + 60_000,
            }],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            account_pnl_events: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([]))

        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(false)
        expect(syncState?.providerStatus).toBe("healthy")
        expect(syncState?.lastDriftSummary).toBeUndefined()
        expect(db.rows.alerts ?? []).toHaveLength(0)
    })

    it("clears stale inferred OKX close accounting faults only when a matching audited close exists", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        vi.useFakeTimers()
        vi.setSystemTime(CLOSED_AT + 120_000)

        try {
            const inferredClose = buildCanonicalCloseOrder({
                id: "order-inferred-close",
                orderId: "vokt01inferredclose",
                ordId: "inferred-close-provider",
                runId: "run-okx-a",
                strategyId: "strategy-okx-a",
                quantity: 5,
                fillPrice: 1877.49,
            })
            const unmatchedInferredClose = buildCanonicalCloseOrder({
                id: "order-unmatched-inferred-close",
                orderId: "vokt01unmatchedclose",
                ordId: "unmatched-inferred-close-provider",
                runId: "run-okx-a",
                strategyId: "strategy-okx-a",
                quantity: 7,
                fillPrice: 1877.49,
            })
            const auditedClose = buildCanonicalCloseOrder({
                id: "order-audited-close",
                orderId: "vokc01auditedclose",
                ordId: "audited-close-provider",
                runId: "run-okx-a",
                strategyId: "strategy-okx-a",
                quantity: 5,
                fillPrice: 1877.49,
            })
            const db = new FakeDb({
                strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
                strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
                instrument_claims: [],
                orders: [
                    inferredClose,
                    unmatchedInferredClose,
                    {
                        ...auditedClose,
                        updatedAt: CLOSED_AT + 30_000,
                        intent: {
                            ...auditedClose.intent,
                            metadata: {
                                orderId: "audited-close-provider",
                                clientOrderId: "vokc01auditedclose",
                                tradeIds: ["audited-close-trade"],
                                source: "okx_fills_history",
                                providerReconciledClose: true,
                                positionSide: "short",
                                fillPnl: 12.4,
                                fee: -0.2,
                            },
                        },
                    },
                ],
                provider_positions: [],
                provider_working_orders: [],
                provider_sync_state: [],
                position_syncs: [],
                positions: [],
                execution_safety_faults: [{
                    _id: "fault-inferred-close-with-audit",
                    strategyId: "strategy-okx-a",
                    app: "okx-swap",
                    accountId,
                    instrument: "ETH-USDT-SWAP",
                    category: "accounting_mismatch",
                    message: "Provider reconciliation inferred a filled close order without provider accounting metadata",
                    canonicalOrderId: "vokt01inferredclose",
                    providerOrderId: "algo:ETH-USDT-SWAP:inferred-close-provider",
                    blocked: true,
                    occurredAt: CLOSED_AT,
                }, {
                    _id: "fault-inferred-close-without-audit",
                    strategyId: "strategy-okx-a",
                    app: "okx-swap",
                    accountId,
                    instrument: "ETH-USDT-SWAP",
                    category: "accounting_mismatch",
                    message: "Provider reconciliation inferred a filled close order without provider accounting metadata",
                    canonicalOrderId: "vokt01unmatchedclose",
                    providerOrderId: "algo:ETH-USDT-SWAP:unmatched-inferred-close-provider",
                    blocked: true,
                    occurredAt: CLOSED_AT,
                }],
                account_snapshots: [{
                    _id: "snapshot-before-close-fault-audit",
                    app: "okx-swap",
                    accountId,
                    venue: "okx",
                    balance: 40_000,
                    equity: 40_000,
                    buyingPower: 20_000,
                    marginUsed: 0,
                    marginAvailable: 20_000,
                    openPnl: 0,
                    dayPnl: 0,
                    timestamp: CLOSED_AT - 60_000,
                }],
                account_pnl_events: [],
                control_plane_metrics: [],
                alerts: [],
            })
            const ctx = { db } as never

            await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([]))

            expect(db.rows.execution_safety_faults).toContainEqual(expect.objectContaining({
                _id: "fault-inferred-close-with-audit",
                blocked: false,
                resolvedAt: CLOSED_AT + 120_000,
                resolutionNote: "Provider reconciliation found audited canonical close order vokc01auditedclose for inferred close vokt01inferredclose",
            }))
            const unmatchedFault = db.rows.execution_safety_faults.find((fault) =>
                fault._id === "fault-inferred-close-without-audit"
            )
            expect(unmatchedFault).toMatchObject({
                blocked: true,
            })
            expect(unmatchedFault?.resolvedAt).toBeUndefined()
            expect(unmatchedFault?.resolutionNote).toBeUndefined()
            expect(db.rows.alerts).toContainEqual(expect.objectContaining({
                strategyId: "strategy-okx-a",
                app: "okx-swap",
                severity: "info",
                message: "[execution-safety] Provider reconciliation cleared 1 inferred close accounting fault(s) after matching audited canonical close evidence",
            }))
        } finally {
            vi.useRealTimers()
        }
    })

    it("fails closed when an owned position disappears without broker close evidence", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [buildOkxStrategy("strategy-okx-a", "OKX A")],
            strategy_runs: [buildOkxRun("run-okx-a", "strategy-okx-a")],
            instrument_claims: [],
            orders: [],
            provider_positions: [
                buildOwnedProviderPosition({
                    id: "provider-position-okx",
                    strategyId: "strategy-okx-a",
                    posId: SHARED_POS_ID,
                    quantity: 5,
                }),
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

        await callRegistered(reconcileProviderPortfolio, ctx, buildReconcileArgs([]))

        expect(db.rows.orders ?? []).toHaveLength(0)

        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(true)
        expect(String(syncState?.lastDriftSummary)).toContain("disappeared without matching broker close evidence")
        expect(String(syncState?.lastDriftSummary)).toContain(`ETH-USDT-SWAP:${SHARED_POS_ID}`)
    })
})
