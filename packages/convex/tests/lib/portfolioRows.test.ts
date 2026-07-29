import { describe, expect, it } from "vitest"
import { upsertProviderWorkingOrderRows } from "../../convex/lib/mutations/portfolioRows"
import { FakeMutationDb } from "./fakeMutationDb"

type ProviderWorkingOrderTestRow = Parameters<typeof upsertProviderWorkingOrderRows>[3][number]

const ONE_HOUR_MS = 60 * 60 * 1000

describe("provider row upserts", () => {
    it("leaves unchanged live working-order syncedAt untouched before the hourly bound", async () => {
        const db = new FakeMutationDb({
            provider_working_orders: [{
                _id: "working-order-1",
                ...createWorkingOrderRow(100),
            }],
        })

        const stats = await upsertProviderWorkingOrderRows(
            { db } as never,
            "mt5",
            "mt5-account",
            [createWorkingOrderRow(100 + ONE_HOUR_MS - 1)],
        )

        expect(stats).toEqual({
            inserted: 0,
            patched: 0,
            deleted: 0,
            unchanged: 1,
        })
        expect(db.rows.provider_working_orders).toEqual([
            expect.objectContaining({
                orderId: "provider-order-1",
                syncedAt: 100,
            }),
        ])
    })

    it("refreshes unchanged live working-order syncedAt when provider truth is hourly stale", async () => {
        const db = new FakeMutationDb({
            provider_working_orders: [{
                _id: "working-order-1",
                ...createWorkingOrderRow(100),
            }],
        })

        const stats = await upsertProviderWorkingOrderRows(
            { db } as never,
            "mt5",
            "mt5-account",
            [createWorkingOrderRow(100 + ONE_HOUR_MS)],
        )

        expect(stats).toEqual({
            inserted: 0,
            patched: 0,
            deleted: 0,
            unchanged: 1,
        })
        expect(db.rows.provider_working_orders).toEqual([
            expect.objectContaining({
                orderId: "provider-order-1",
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
