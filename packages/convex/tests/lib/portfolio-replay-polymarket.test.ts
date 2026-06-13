import { describe, expect, it } from "vitest"
import { resolveOrderRealizedPnl } from "@valiq-trading/core"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex Polymarket settlement replay", () => {
    it("imports redeemable provider positions as accounted synthetic closes instead of vanished exposure", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-polymarket"
        const runId = "run-polymarket"
        const accountId = "polymarket-account"
        const tokenId = "token-redeemable"
        const openedAt = Date.parse("2026-04-10T10:00:00.000Z")
        const closedAt = Date.parse("2026-04-12T10:00:00.000Z")
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "polymarket",
                accountId,
                name: "Polymarket settlement",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                startedAt: openedAt,
                endedAt: undefined,
            }],
            instrument_claims: [],
            orders: [],
            provider_positions: [{
                _id: "provider-position-1",
                app: "polymarket",
                accountId,
                positionKey: `${tokenId}:long`,
                providerPositionId: undefined,
                strategyId,
                ownershipStatus: "owned",
                expectedExternal: false,
                instrument: tokenId,
                side: "long",
                quantity: 5,
                entryPrice: 0.3,
                currentPrice: 0.9,
                unrealizedPnl: 3,
                metadata: JSON.stringify({
                    venue: "polymarket",
                    tokenId,
                    conditionId: "condition-redeemable",
                    market: "condition-redeemable",
                    marketSlug: "redeemable-position",
                    outcome: "Yes",
                }),
                syncedAt: openedAt,
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
            trade_events: [],
            order_transitions: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "polymarket",
            accountId,
            venue: "polymarket",
            source: "periodic_sync",
            accountState: {
                balance: 100,
                equity: 105,
                buyingPower: 100,
                marginUsed: 5,
                marginAvailable: 100,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: tokenId,
                providerPositionId: tokenId,
                side: "long",
                quantity: 5,
                fillPrice: 1,
                closedAt,
                metadata: JSON.stringify({
                    providerAccountingSource: "polymarket_position_settlement",
                    providerPositionId: tokenId,
                    tokenId,
                    asset: tokenId,
                    conditionId: "condition-redeemable",
                    fillPnl: 3.5,
                    fee: 0,
                    feeCcy: "USDC",
                }),
            }],
        })

        expect(db.rows.provider_positions ?? []).toHaveLength(0)
        const closeOrder = (db.rows.orders ?? []).find((order) =>
            String(order.orderId).startsWith("provider-close:polymarket:")
        )
        expect(closeOrder).toMatchObject({
            strategyId,
            accountId,
            instrument: tokenId,
            action: "close",
            status: "filled",
            quantity: 5,
            filledQuantity: 5,
            avgFillPrice: 1,
        })
        expect(resolveOrderRealizedPnl(closeOrder as never)).toBe(3.5)
        const closeIntent = typeof closeOrder?.intent === "string"
            ? JSON.parse(closeOrder.intent)
            : closeOrder?.intent as { metadata?: Record<string, unknown> } | undefined
        expect(closeIntent?.metadata).toMatchObject({
            providerAccountingSource: "polymarket_position_settlement",
            tokenId,
            fillPnl: 3.5,
            fee: 0,
            feeCcy: "USDC",
        })
        expect(db.rows.execution_safety_faults ?? []).toEqual([])
        expect(db.rows.trade_events ?? []).toEqual([
            expect.objectContaining({
                app: "polymarket",
                accountId,
                eventType: "filled",
            }),
        ])
    })
})
