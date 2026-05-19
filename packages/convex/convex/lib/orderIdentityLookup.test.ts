import { describe, expect, it } from "vitest"
import { findOrderRowByIdentity } from "./orderIdentityLookup"

describe("order identity lookup", () => {
    it("resolves persisted orders by provider order aliases", async () => {
        const order = {
            orderId: "vokm01abcdef2345",
            providerOrderId: "algo:BTC-USDT-SWAP:algo-1",
            providerClientOrderId: "vokt01abcde23456",
            providerOrderAliases: ["algo-1", "legacy-algo-1"],
            signedOrderFingerprint: undefined,
        }

        const found = await findOrderRowByIdentity(
            createOrderIdentityDb([order]),
            "legacy-algo-1"
        )

        expect(found).toBe(order)
    })
})

function createOrderIdentityDb(orders: Array<Record<string, unknown>>) {
    return {
        query: () => ({
            withIndex: (_indexName: string, buildQuery: (q: {
                eq: (field: string, value: unknown) => unknown
            }) => unknown) => {
                let fieldName = ""
                let fieldValue: unknown
                const query = {
                    eq: (field: string, value: unknown) => {
                        fieldName = field
                        fieldValue = value
                        return query
                    },
                }

                buildQuery(query)

                return {
                    first: async () =>
                        orders.find((order) => order[fieldName] === fieldValue) ?? null,
                }
            },
            collect: async () => orders,
        }),
    } as never
}
