import { describe, expect, it } from "vitest"
import { assertStrategyDeletionSafe } from "./mutations/strategyCascadeDelete"
import { buildStrategyPositionSnapshotHashPayload } from "./mutations/portfolioSnapshots"

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
