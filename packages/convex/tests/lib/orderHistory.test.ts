import { describe, expect, it } from "vitest"
import { getStrategyOrderHistory } from "../../convex/lib/queries/orders"
import { callRegisteredQuery, type FakeRow } from "./fakeQueryDb"

describe("getStrategyOrderHistory", () => {
    it("uses a bounded default limit for indexed recent order history", async () => {
        const strategyId = "strategy-history"
        const rows = createOrderRows(strategyId, 55)

        const result = await callRegisteredQuery(getStrategyOrderHistory, {
            orders: rows,
        }, {
            strategyId,
        }) as FakeRow[]

        expect(result).toHaveLength(50)
        expect(result[0]?.updatedAt).toBe(54)
        expect(result.at(-1)?.updatedAt).toBe(5)
    })

    it("caps explicit strategy order history limits", async () => {
        const strategyId = "strategy-history-cap"
        const rows = createOrderRows(strategyId, 520)

        const result = await callRegisteredQuery(getStrategyOrderHistory, {
            orders: rows,
        }, {
            strategyId,
            limit: 999,
        }) as FakeRow[]

        expect(result).toHaveLength(500)
        expect(result[0]?.updatedAt).toBe(519)
        expect(result.at(-1)?.updatedAt).toBe(20)
    })
})

function createOrderRows(strategyId: string, count: number): FakeRow[] {
    return Array.from({ length: count }, (_, index) => ({
        _id: `order-${index}`,
        orderId: `order-${index}`,
        strategyId,
        status: "filled",
        updatedAt: index,
    }))
}
