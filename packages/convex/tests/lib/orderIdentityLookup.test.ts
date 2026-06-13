import { describe, expect, it } from "vitest"
import { findOrderRowByIdentity } from "../../convex/lib/orderIdentityLookup"

describe("order identity lookup", () => {
    it("resolves persisted orders by provider order aliases within the account scope", async () => {
        const order = {
            orderId: "vokm01abcdef2345",
            providerOrderId: "algo:BTC-USDT-SWAP:algo-1",
            providerClientOrderId: "vokt01abcde23456",
            providerOrderAliases: ["algo-1", "legacy-algo-1"],
            signedOrderFingerprint: undefined,
            app: "okx-swap",
            accountId: "account-a",
            strategyId: "strategy-a",
        }
        const otherOrder = {
            orderId: "vokm01otherorder",
            providerOrderId: "algo:BTC-USDT-SWAP:algo-1",
            providerClientOrderId: "vokt01otherorder",
            providerOrderAliases: ["legacy-algo-1"],
            signedOrderFingerprint: undefined,
            app: "okx-swap",
            accountId: "account-b",
            strategyId: "strategy-b",
        }

        const found = await findOrderRowByIdentity(
            createOrderIdentityDb([otherOrder, order]),
            "legacy-algo-1",
            {
                app: "okx-swap" as never,
                accountId: "account-a",
                strategyId: "strategy-a" as never,
            }
        )

        expect(found).toBe(order)
    })

    it("does not resolve provider order aliases without an account scope", async () => {
        const order = {
            orderId: "vokm01abcdef2345",
            providerOrderId: "algo:BTC-USDT-SWAP:algo-1",
            providerClientOrderId: "vokt01abcde23456",
            providerOrderAliases: ["legacy-algo-1"],
            signedOrderFingerprint: undefined,
            app: "okx-swap",
            accountId: "account-a",
            strategyId: "strategy-a",
        }

        const found = await findOrderRowByIdentity(
            createOrderIdentityDb([order]),
            "legacy-algo-1"
        )

        expect(found).toBeNull()
    })
})

function createOrderIdentityDb(orders: Array<Record<string, unknown>>) {
    return {
        query: () => ({
            withIndex: (_indexName: string, buildQuery: (q: {
                eq: (field: string, value: unknown) => unknown
            }) => unknown) => {
                const filters: Array<{ field: string; value: unknown }> = []
                const query = {
                    eq: (field: string, value: unknown) => {
                        filters.push({ field, value })
                        return query
                    },
                }

                buildQuery(query)

                return {
                    first: async () =>
                        orders.find((order) =>
                            filters.every((filter) => order[filter.field] === filter.value)
                        ) ?? null,
                    collect: async () =>
                        orders.filter((order) =>
                            filters.every((filter) => order[filter.field] === filter.value)
                        ),
                }
            },
            collect: async () => orders,
        }),
    } as never
}
