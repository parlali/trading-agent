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
            createOrderIdentityDb(
                [otherOrder, order],
                [
                    {
                        app: "okx-swap",
                        accountId: "account-a",
                        alias: "legacy-algo-1",
                        orderId: "vokm01abcdef2345",
                        orderDocId: "order-2",
                        strategyId: "strategy-a",
                        updatedAt: 1,
                    },
                    {
                        app: "okx-swap",
                        accountId: "account-b",
                        alias: "legacy-algo-1",
                        orderId: "vokm01otherorder",
                        orderDocId: "order-1",
                        strategyId: "strategy-b",
                        updatedAt: 1,
                    },
                ]
            ),
            "legacy-algo-1",
            {
                app: "okx-swap" as never,
                accountId: "account-a",
                strategyId: "strategy-a" as never,
            }
        )

        expect(found).toMatchObject(order)
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

    it("fails closed instead of scanning account orders when the alias projection is missing", async () => {
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
        const db = createOrderIdentityDb([order], [])

        const found = await findOrderRowByIdentity(
            db,
            "legacy-algo-1",
            {
                app: "okx-swap" as never,
                accountId: "account-a",
                strategyId: "strategy-a" as never,
            }
        )

        expect(found).toBeNull()
        expect(db.scannedAccountOrders).toBe(false)
    })
})

function createOrderIdentityDb(
    orderRows: Array<Record<string, unknown>>,
    aliasRows: Array<Record<string, unknown>> = []
) {
    const orders = orderRows.map((order, index) => ({
        _id: `order-${index + 1}`,
        ...order,
    }))
    const aliases = aliasRows.map((alias, index) => ({
        _id: `alias-${index + 1}`,
        ...alias,
    }))
    const db = {
        scannedAccountOrders: false,
        query: (table: string) => ({
            withIndex: (_indexName: string, buildQuery: (q: {
                eq: (field: string, value: unknown) => unknown
            }) => unknown) => {
                if (table === "orders" && _indexName === "by_app_account") {
                    db.scannedAccountOrders = true
                }
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
                        tableRows(table).find((order) =>
                            filters.every((filter) => order[filter.field] === filter.value)
                        ) ?? null,
                    collect: async () =>
                        tableRows(table).filter((order) =>
                            filters.every((filter) => order[filter.field] === filter.value)
                        ),
                }
            },
            collect: async () => tableRows(table),
        }),
        get: async (id: string) =>
            tableRows("orders").find((order) => order._id === id) ?? null,
    }

    function tableRows(table: string) {
        if (table === "orders") {
            return orders
        }
        if (table === "order_identity_aliases") {
            return aliases
        }
        return []
    }

    return db as never
}
