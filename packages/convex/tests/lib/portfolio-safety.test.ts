import { describe, expect, it } from "vitest"
import { createEmptyCascadeDeleteCounts } from "../../convex/lib/cascadeDelete"
import {
    assertStrategyDeletionSafe,
    deleteFinalStrategyAppRows,
    deleteStrategyTableBatch,
} from "../../convex/lib/mutations/strategyCascadeDelete"
import { buildStrategyPositionSnapshotHashPayload } from "../../convex/lib/mutations/portfolioSnapshots"

type RowsByTable = Record<string, unknown[] | undefined>
type MutableRow = { _id: string, [key: string]: unknown }
type MutableRowsByTable = Record<string, MutableRow[] | undefined>

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

function createCascadeDeleteCtx(rows: MutableRowsByTable) {
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
                            async take(limit: number) {
                                return tableRows.slice(0, limit)
                            },
                        }
                    },
                }
            },
            async delete(id: string) {
                for (const table of Object.keys(rows)) {
                    const tableRows = rows[table] ?? []
                    const index = tableRows.findIndex((row) => row._id === id)

                    if (index >= 0) {
                        tableRows.splice(index, 1)
                        return
                    }
                }
            },
        },
    }
}

function createLiveStrategy() {
    return {
        _id: "strategy-live",
        app: "mt5",
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

    it("keeps provider verification rows until the final strategy delete batch", async () => {
        const rows: MutableRowsByTable = {
            strategies: [{
                _id: "strategy-live",
                app: "mt5",
            }],
            account_snapshots: [{
                _id: "snapshot-1",
                app: "mt5",
            }],
            provider_sync_state: [{
                _id: "sync-1",
                app: "mt5",
            }],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "mt5",
            }],
        }
        const deleted = createEmptyCascadeDeleteCounts()
        const ctx = createCascadeDeleteCtx(rows)

        await expect(deleteStrategyTableBatch(ctx as never, "strategy-live" as never, "mt5" as never, deleted, 50))
            .resolves
            .toBe(true)

        expect(deleted.accountSnapshots).toBe(1)
        expect(deleted.providerSyncStates).toBe(0)
        expect(deleted.appHeartbeats).toBe(0)
        expect(rows.provider_sync_state).toHaveLength(1)
        expect(rows.app_heartbeats).toHaveLength(1)

        await expect(deleteStrategyTableBatch(ctx as never, "strategy-live" as never, "mt5" as never, deleted, 50))
            .resolves
            .toBe(false)

        await deleteFinalStrategyAppRows(ctx as never, "mt5" as never, deleted)

        expect(deleted.providerSyncStates).toBe(1)
        expect(deleted.appHeartbeats).toBe(1)
        expect(rows.provider_sync_state).toHaveLength(0)
        expect(rows.app_heartbeats).toHaveLength(0)
    })

    it("keeps provider verification rows while sibling strategies remain", async () => {
        const rows: MutableRowsByTable = {
            strategies: [
                {
                    _id: "strategy-live",
                    app: "okx-swap",
                },
                {
                    _id: "strategy-sibling",
                    app: "okx-swap",
                },
            ],
            provider_sync_state: [{
                _id: "sync-1",
                app: "okx-swap",
            }],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        }
        const deleted = createEmptyCascadeDeleteCounts()
        const ctx = createCascadeDeleteCtx(rows)

        await deleteFinalStrategyAppRows(ctx as never, "okx-swap" as never, deleted)

        expect(deleted.providerSyncStates).toBe(0)
        expect(deleted.appHeartbeats).toBe(0)
        expect(rows.provider_sync_state).toHaveLength(1)
        expect(rows.app_heartbeats).toHaveLength(1)
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
