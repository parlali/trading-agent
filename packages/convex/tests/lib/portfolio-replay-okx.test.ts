import { describe, expect, it } from "vitest"
import { resolveCloseOrderRealizedPnl } from "@valiq-trading/core"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex OKX net-mode closure replay", () => {
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
                name: "OKX ETH",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "okx-swap",
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

    const SHARED_POS_ID = "3618122936764637184"
    const OPENED_AT = 1_780_430_000_000
    const CLOSED_AT = OPENED_AT + 600_000

    function buildOkxStrategy(id: string, name: string) {
        return {
            _id: id,
            app: "okx-swap",
            name,
            policy: { dryRun: false },
        }
    }

    function buildOkxRun(id: string, strategyId: string) {
        return {
            _id: id,
            strategyId,
            app: "okx-swap",
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
        ordId?: string
        clientOrderId?: string
        closedAt?: number
    }) {
        return {
            instrument: "ETH-USDT-SWAP",
            side: "short",
            quantity: args.quantity,
            fillPrice: args.fillPrice,
            closedAt: args.closedAt ?? CLOSED_AT,
            metadata: JSON.stringify({
                orderId: args.ordId,
                clientOrderId: args.clientOrderId,
                fillPnl: args.fillPnl,
                posSide: "net",
                source: "okx_fills_history",
            }),
        }
    }

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

    it("fails closed with a drift alert when a broker close cannot be attributed to a single owned position", async () => {
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
                    strategyId: "strategy-okx-b",
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
        expect(String(syncState?.lastDriftSummary)).toContain("could not be safely attributed")

        const driftAlert = (db.rows.alerts ?? []).find((alert) =>
            String(alert.message).includes("could not be safely attributed")
        )
        expect(driftAlert).toBeDefined()
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
