import { describe, expect, it } from "vitest"
import { createEmptyCascadeDeleteCounts } from "../../convex/lib/cascadeDelete"
import { operatorReconcileVerifiedFlatProviderState } from "../../convex/lib/mutations/portfolio"
import {
    assertStrategyDeletionSafe,
    cascadeDeleteStrategy,
    deleteFinalStrategyAccountRows,
    deleteFinalStrategyAppRows,
    deleteStrategyTableBatch,
} from "../../convex/lib/mutations/strategyCascadeDelete"
import { buildStrategyPositionSnapshotHashPayload } from "../../convex/lib/mutations/portfolioSnapshots"
import { callRegistered, FakeMutationDb } from "./fakeMutationDb"

type RowsByTable = Record<string, unknown[] | undefined>

function createDeletionSafetyCtx(rows: RowsByTable) {
    return {
        db: {
            query(table: string) {
                const tableRows = rows[table] ?? []

                return {
                    withIndex() {
                        return {
                            async first() {
                                return tableRows[0] ?? null
                            },
                            async collect() {
                                return tableRows
                            },
                        }
                    },
                }
            },
        },
    }
}

function createLiveStrategy() {
    return {
        _id: "strategy-live",
        app: "mt5",
        accountId: "acct-1",
        policy: {
            dryRun: false,
        },
    }
}

describe("portfolio safety guards", () => {
    it("fails closed when deleting a live strategy without provider verification state", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({}) as never, createLiveStrategy() as never))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("allows force reset to delete unverified live strategies only when tracked provider state is empty", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({}) as never, createLiveStrategy() as never, {
            allowUnverifiedEmptyProviderState: true,
        }))
            .resolves
            .toBeUndefined()
    })

    it("does not allow force reset to delete unverified live strategies with tracked provider exposure", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_positions: [{
                _id: "position-1",
            }],
        }) as never, createLiveStrategy() as never, {
            allowUnverifiedEmptyProviderState: true,
        }))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("allows force reset to delete stale provider rows only after external flat verification", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_positions: [{
                _id: "position-1",
            }],
        }) as never, createLiveStrategy() as never, {
            allowVerifiedFlatProviderState: true,
        }))
            .resolves
            .toBeUndefined()
    })

    it("does not allow external flat verification to bypass pending order lifecycle state", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            orders: [{
                _id: "order-1",
            }],
        }) as never, createLiveStrategy() as never, {
            allowVerifiedFlatProviderState: true,
        }))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("fails closed when deleting a live strategy with missing provider verification timestamp", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_sync_state: [{
                providerStatus: "healthy",
                driftDetected: false,
            }],
        }) as never, createLiveStrategy() as never))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("allows deleting a live strategy only after recent healthy provider verification and no exposure", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_sync_state: [{
                providerStatus: "healthy",
                driftDetected: false,
                lastVerifiedAt: Date.now(),
            }],
        }) as never, createLiveStrategy() as never))
            .resolves
            .toBeUndefined()
    })

    it("refuses operator flat reconciliation while Convex still tracks provider exposure", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            provider_positions: [{
                _id: "provider-position-live",
                app: "mt5",
                accountId: "account-mt5",
                instrument: "US30",
            }],
            provider_working_orders: [],
            provider_position_history: [],
            provider_sync_state: [],
            alerts: [],
        })

        await expect(callRegistered(operatorReconcileVerifiedFlatProviderState, { db } as never, {
            serviceToken: "test-token",
            app: "mt5",
            accountId: "account-mt5",
            evidence: {
                livePositionCount: 0,
                liveWorkingOrderCount: 0,
                closureLookbackHours: 168,
                note: "worker verified flat",
            },
        }))
            .rejects
            .toThrow("Cannot operator-reconcile mt5:account-mt5 as flat while Convex still has 1 provider position")
    })

    it("clears retained disappeared history only after operator flat evidence", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            provider_positions: [],
            provider_working_orders: [],
            provider_position_history: [{
                _id: "provider-history-1",
                app: "mt5",
                accountId: "account-mt5",
                positionKey: "US30:provider-position-1",
                providerPositionId: "provider-position-1",
            }],
            provider_sync_state: [{
                _id: "sync-1",
                app: "mt5",
                accountId: "account-mt5",
                accountScope: "account",
                providerStatus: "degraded",
                stale: false,
                driftDetected: true,
                lastDriftSummary: "1 owned position disappeared without matching broker close evidence",
                positionCount: 0,
                pendingOrderCount: 0,
                updatedAt: 1,
            }],
            alerts: [],
        })

        const result = await callRegistered(operatorReconcileVerifiedFlatProviderState, { db } as never, {
            serviceToken: "test-token",
            app: "mt5",
            accountId: "account-mt5",
            evidence: {
                livePositionCount: 0,
                liveWorkingOrderCount: 0,
                closureLookbackHours: 168,
                note: "worker verified flat from localhost",
            },
        })

        expect(result).toMatchObject({
            deletedProviderPositionHistory: 1,
            providerStatus: "healthy",
            driftDetected: false,
        })
        expect(db.rows.provider_position_history).toHaveLength(0)
        expect(db.rows.provider_sync_state?.[0]).toMatchObject({
            providerStatus: "healthy",
            stale: false,
            driftDetected: false,
            lastError: undefined,
            lastDriftSummary: undefined,
            positionCount: 0,
            pendingOrderCount: 0,
        })
        expect(db.rows.alerts?.[0]?.message).toContain("operator reconciled verified-flat provider state")
    })

    it("scopes batched last-strategy cleanup to the strategy account and keeps account snapshots", async () => {
        const db = new FakeMutationDb({
            strategies: [{
                _id: "strategy-live",
                app: "mt5",
                accountId: "acct-1",
            }],
            account_snapshots: [{
                _id: "snapshot-1",
                app: "mt5",
                accountId: "acct-1",
            }],
            provider_sync_state: [{
                _id: "sync-1",
                app: "mt5",
                accountId: "acct-1",
            }],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "mt5",
            }],
        })
        const deleted = createEmptyCascadeDeleteCounts()
        const ctx = { db }

        await expect(deleteStrategyTableBatch(ctx as never, "strategy-live" as never, "mt5" as never, deleted, 50))
            .resolves
            .toBe(false)

        expect(deleted.accountSnapshots).toBe(0)
        expect(deleted.providerSyncStates).toBe(0)
        expect(deleted.appHeartbeats).toBe(0)
        expect(db.rows.account_snapshots).toHaveLength(1)
        expect(db.rows.provider_sync_state).toHaveLength(1)
        expect(db.rows.app_heartbeats).toHaveLength(1)

        await deleteFinalStrategyAccountRows(ctx as never, {
            _id: "strategy-live",
            app: "mt5",
            accountId: "acct-1",
        } as never, deleted)

        expect(deleted.providerSyncStates).toBe(1)
        expect(db.rows.provider_sync_state).toHaveLength(0)

        await deleteFinalStrategyAppRows(ctx as never, "mt5" as never, deleted)

        expect(deleted.appHeartbeats).toBe(1)
        expect(db.rows.account_snapshots).toHaveLength(1)
        expect(db.rows.app_heartbeats).toHaveLength(0)
    })

    it("does not touch sibling account rows when deleting the last strategy of one account", async () => {
        const db = new FakeMutationDb({
            strategies: [
                {
                    _id: "strategy-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "strategy-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            provider_positions: [
                {
                    _id: "pos-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "pos-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            provider_working_orders: [
                {
                    _id: "wo-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "wo-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            provider_sync_state: [
                {
                    _id: "sync-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "sync-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            account_snapshots: [
                {
                    _id: "snap-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "snap-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        })
        const ctx = { db }

        const counts = await cascadeDeleteStrategy(ctx as never, "strategy-a" as never)

        expect(counts.providerPositions).toBe(1)
        expect(counts.providerWorkingOrders).toBe(1)
        expect(counts.providerSyncStates).toBe(1)
        expect(counts.accountSnapshots).toBe(0)
        expect(counts.appHeartbeats).toBe(0)
        expect(db.rows.provider_positions?.map((row) => row._id)).toEqual(["pos-b"])
        expect(db.rows.provider_working_orders?.map((row) => row._id)).toEqual(["wo-b"])
        expect(db.rows.provider_sync_state?.map((row) => row._id)).toEqual(["sync-b"])
        expect(db.rows.account_snapshots?.map((row) => row._id)).toEqual(["snap-a", "snap-b"])
        expect(db.rows.app_heartbeats).toHaveLength(1)
        expect(db.rows.strategies?.map((row) => row._id)).toEqual(["strategy-b"])
    })

    it("keeps account snapshots and pnl events when deleting the last strategy for an app", async () => {
        const db = new FakeMutationDb({
            strategies: [{
                _id: "strategy-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            provider_sync_state: [{
                _id: "sync-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            account_snapshots: [{
                _id: "snap-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            account_pnl_events: [{
                _id: "pnl-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        })
        const ctx = { db }

        const counts = await cascadeDeleteStrategy(ctx as never, "strategy-a" as never)

        expect(counts.providerSyncStates).toBe(1)
        expect(counts.accountSnapshots).toBe(0)
        expect(counts.appHeartbeats).toBe(1)
        expect(db.rows.account_snapshots).toHaveLength(1)
        expect(db.rows.account_pnl_events).toHaveLength(1)
        expect(db.rows.provider_sync_state).toHaveLength(0)
        expect(db.rows.app_heartbeats).toHaveLength(0)
    })

    it("keeps app heartbeats while sibling strategies remain", async () => {
        const db = new FakeMutationDb({
            strategies: [
                {
                    _id: "strategy-live",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "strategy-sibling",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        })
        const deleted = createEmptyCascadeDeleteCounts()

        await deleteFinalStrategyAppRows({ db } as never, "okx-swap" as never, deleted)

        expect(deleted.appHeartbeats).toBe(0)
        expect(db.rows.app_heartbeats).toHaveLength(1)
    })

    it("keeps provider identity and protection levels in strategy position snapshot hashes", () => {
        const payload = buildStrategyPositionSnapshotHashPayload([
            {
                instrument: "XAUUSD",
                positionKey: "XAUUSD:1600791765",
                providerPositionId: "1600791765",
                side: "long",
                quantity: 0.02,
                entryPrice: 3350,
                currentPrice: 3362,
                unrealizedPnl: 24,
                stopLoss: 3290,
                takeProfit: 3450,
                metadata: JSON.stringify({ ticket: 1600791765 }),
            },
            {
                instrument: "XAUUSD",
                positionKey: "XAUUSD:1600791764",
                providerPositionId: "1600791764",
                side: "long",
                quantity: 0.01,
                entryPrice: 3340,
                currentPrice: 3362,
                unrealizedPnl: 22,
                stopLoss: 3300,
                takeProfit: 3425,
                metadata: JSON.stringify({ ticket: 1600791764 }),
            },
        ])

        expect(payload).toEqual([
            expect.objectContaining({
                positionKey: "XAUUSD:1600791764",
                providerPositionId: "1600791764",
                stopLoss: 3300,
                takeProfit: 3425,
            }),
            expect.objectContaining({
                positionKey: "XAUUSD:1600791765",
                providerPositionId: "1600791765",
                stopLoss: 3290,
                takeProfit: 3450,
            }),
        ])
    })
})
