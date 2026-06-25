import type { DatabaseReader, DatabaseWriter } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"

type OrderIdentityAliasApp = NonNullable<Doc<"orders">["app"]>

export type OrderIdentityAliasScope = {
    app: OrderIdentityAliasApp
    accountId: string
    strategyId?: Id<"strategies">
}

export type OrderIdentityAliasProjectionInput = {
    _id: Id<"orders">
    app?: Doc<"orders">["app"]
    accountId?: string
    strategyId: Id<"strategies">
    orderId: string
    providerOrderId: string
    providerClientOrderId?: string
    signedOrderFingerprint?: string
    providerOrderAliases?: string[]
    updatedAt: number
}

type OrderIdentityAliasReconcileStats = {
    inserted: number
    patched: number
    deleted: number
    unchanged: number
}

export function projectOrderIdentityAliases(
    order: Pick<
        OrderIdentityAliasProjectionInput,
        "orderId" | "providerOrderId" | "providerClientOrderId" | "signedOrderFingerprint" | "providerOrderAliases"
    >
): string[] {
    const primaryIdentities = new Set([
        normalizeOrderIdentityAlias(order.orderId),
        normalizeOrderIdentityAlias(order.providerOrderId),
        normalizeOrderIdentityAlias(order.providerClientOrderId),
        normalizeOrderIdentityAlias(order.signedOrderFingerprint),
    ].filter((value): value is string => value !== undefined))
    const aliases = new Set<string>()

    for (const value of order.providerOrderAliases ?? []) {
        const alias = normalizeOrderIdentityAlias(value)
        if (!alias || primaryIdentities.has(alias)) {
            continue
        }
        aliases.add(alias)
    }

    return Array.from(aliases).sort((left, right) => left.localeCompare(right))
}

export async function findOrderRowByAlias(
    db: DatabaseReader,
    args: OrderIdentityAliasScope & {
        alias: string
    }
): Promise<Doc<"orders"> | null> {
    const alias = normalizeOrderIdentityAlias(args.alias)
    if (!alias) {
        return null
    }

    const aliasRows = await db
        .query("order_identity_aliases")
        .withIndex("by_app_account_alias", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("alias", alias)
        )
        .collect()

    for (const aliasRow of aliasRows) {
        if (args.strategyId !== undefined && aliasRow.strategyId !== args.strategyId) {
            continue
        }

        const order = await db.get(aliasRow.orderDocId)
        if (!order || !orderMatchesAliasRow(order, aliasRow)) {
            continue
        }

        return order
    }

    return null
}

export async function reconcileOrderIdentityAliases(
    ctx: { db: DatabaseWriter },
    order: OrderIdentityAliasProjectionInput
): Promise<OrderIdentityAliasReconcileStats> {
    const aliases = order.app && order.accountId
        ? new Set(projectOrderIdentityAliases(order))
        : new Set<string>()
    const existingRows = await ctx.db
        .query("order_identity_aliases")
        .withIndex("by_order_doc", (q) => q.eq("orderDocId", order._id))
        .collect()
    const retainedAliases = new Set<string>()
    const stats: OrderIdentityAliasReconcileStats = {
        inserted: 0,
        patched: 0,
        deleted: 0,
        unchanged: 0,
    }

    for (const row of existingRows) {
        if (!aliases.has(row.alias) || retainedAliases.has(row.alias) || !order.app || !order.accountId) {
            await ctx.db.delete(row._id)
            stats.deleted++
            continue
        }

        retainedAliases.add(row.alias)

        if (
            row.app !== order.app ||
            row.accountId !== order.accountId ||
            row.orderId !== order.orderId ||
            row.strategyId !== order.strategyId ||
            row.updatedAt !== order.updatedAt
        ) {
            await ctx.db.patch(row._id, {
                app: order.app,
                accountId: order.accountId,
                orderId: order.orderId,
                strategyId: order.strategyId,
                updatedAt: order.updatedAt,
            })
            stats.patched++
            continue
        }

        stats.unchanged++
    }

    if (!order.app || !order.accountId) {
        return stats
    }

    for (const alias of aliases) {
        if (retainedAliases.has(alias)) {
            continue
        }

        await ctx.db.insert("order_identity_aliases", {
            app: order.app,
            accountId: order.accountId,
            alias,
            orderId: order.orderId,
            orderDocId: order._id,
            strategyId: order.strategyId,
            updatedAt: order.updatedAt,
        })
        stats.inserted++
    }

    return stats
}

export async function deleteOrderIdentityAliasesForOrder(
    ctx: { db: DatabaseWriter },
    orderDocId: Id<"orders">
): Promise<number> {
    const aliasRows = await ctx.db
        .query("order_identity_aliases")
        .withIndex("by_order_doc", (q) => q.eq("orderDocId", orderDocId))
        .collect()

    for (const aliasRow of aliasRows) {
        await ctx.db.delete(aliasRow._id)
    }

    return aliasRows.length
}

function normalizeOrderIdentityAlias(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined
    }

    const alias = value.trim()
    return alias.length > 0 ? alias : undefined
}

function orderMatchesAliasRow(
    order: Doc<"orders">,
    row: Doc<"order_identity_aliases">
): boolean {
    return order.app === row.app &&
        order.accountId === row.accountId &&
        order.strategyId === row.strategyId &&
        order.orderId === row.orderId &&
        projectOrderIdentityAliases(order).includes(row.alias)
}
