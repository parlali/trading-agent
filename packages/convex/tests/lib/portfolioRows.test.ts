import { describe, expect, it } from "vitest"
import {
    upsertProviderPositionRows,
    upsertProviderWorkingOrderRows,
} from "../../convex/lib/mutations/portfolioRows"
import { FakeMutationDb } from "./fakeMutationDb"

type ProviderWorkingOrderTestRow = Parameters<typeof upsertProviderWorkingOrderRows>[3][number]
type ProviderPositionTestRow = Parameters<typeof upsertProviderPositionRows>[3][number]

const ONE_HOUR_MS = 60 * 60 * 1000

describe("provider row upserts", () => {
    it("never patches an unchanged live working order", async () => {
        const db = new FakeMutationDb({
            provider_working_orders: [{
                _id: "working-order-1",
                ...createWorkingOrderRow(100),
            }],
        })

        for (const syncedAt of [100 + ONE_HOUR_MS - 1, 100 + ONE_HOUR_MS, 100 + 24 * ONE_HOUR_MS]) {
            const stats = await upsertProviderWorkingOrderRows(
                { db } as never,
                "mt5",
                "mt5-account",
                [createWorkingOrderRow(syncedAt)],
            )

            expect(stats).toEqual({
                inserted: 0,
                patched: 0,
                deleted: 0,
                unchanged: 1,
            })
        }
        expect(db.rows.provider_working_orders).toEqual([
            expect.objectContaining({
                orderId: "provider-order-1",
                syncedAt: 100,
            }),
        ])
    })

    it("leaves unchanged position syncedAt untouched before the hourly bound", async () => {
        const db = new FakeMutationDb({
            provider_positions: [{
                _id: "position-1",
                ...createPositionRow(100),
            }],
        })

        const stats = await upsertProviderPositionRows(
            { db } as never,
            "polymarket",
            "poly-account",
            [createPositionRow(100 + ONE_HOUR_MS - 1)],
            100 + ONE_HOUR_MS - 1,
        )

        expect(stats).toEqual({
            inserted: 0,
            patched: 0,
            deleted: 0,
            unchanged: 1,
        })
        expect(db.rows.provider_positions).toEqual([
            expect.objectContaining({
                positionKey: "position-key-1",
                syncedAt: 100,
            }),
        ])
    })

    it("refreshes unchanged position syncedAt once provider truth is hourly stale", async () => {
        const db = new FakeMutationDb({
            provider_positions: [{
                _id: "position-1",
                ...createPositionRow(100),
            }],
        })

        const stats = await upsertProviderPositionRows(
            { db } as never,
            "polymarket",
            "poly-account",
            [createPositionRow(100 + ONE_HOUR_MS)],
            100 + ONE_HOUR_MS,
        )

        expect(stats).toEqual({
            inserted: 0,
            patched: 0,
            deleted: 0,
            unchanged: 1,
        })
        expect(db.rows.provider_positions).toEqual([
            expect.objectContaining({
                positionKey: "position-key-1",
                syncedAt: 100 + ONE_HOUR_MS,
            }),
        ])
    })
})

function createWorkingOrderRow(syncedAt: number): ProviderWorkingOrderTestRow {
    return {
        app: "mt5",
        accountId: "mt5-account",
        orderId: "provider-order-1",
        providerOrderAliases: ["alias-1"],
        ownershipStatus: "owned",
        expectedExternal: false,
        venue: "mt5",
        instrument: "XAUUSD",
        status: "pending",
        action: "entry",
        side: "buy",
        quantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        submittedAt: 100,
        updatedAt: 100,
        syncedAt,
    }
}

function createPositionRow(syncedAt: number): ProviderPositionTestRow {
    return {
        app: "polymarket",
        accountId: "poly-account",
        positionKey: "position-key-1",
        ownershipStatus: "external",
        instrument: "market-1",
        side: "long",
        quantity: 2,
        entryPrice: 0.4,
        currentPrice: 0.4,
        unrealizedPnl: 0,
        syncedAt,
    }
}
