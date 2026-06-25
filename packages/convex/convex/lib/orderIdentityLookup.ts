import { isCanonicalExecutionOrderId } from "@valiq-trading/core"
import type { DatabaseReader } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { findOrderRowByAlias } from "./orderIdentityAliases"

export type OrderIdentityLookupScope = {
    app?: Doc<"orders">["app"]
    accountId?: string
    strategyId?: Id<"strategies">
}

export async function findOrderRowByIdentity(
    db: DatabaseReader,
    orderId: string,
    scope: OrderIdentityLookupScope = {}
): Promise<Doc<"orders"> | null> {
    const byCanonicalId = await findScopedOrderByIndexedIdentity(
        db,
        "by_order_id",
        "orderId",
        orderId,
        scope
    )

    if (byCanonicalId) {
        return byCanonicalId
    }

    const providerIdentityScoped = hasOrderIdentityScope(scope)
    if (!providerIdentityScoped && (isCanonicalExecutionOrderId(orderId) || orderId.startsWith("provider-close:"))) {
        return null
    }
    if (!providerIdentityScoped) {
        return null
    }

    const byProviderClientOrderId = await findScopedOrderByIndexedIdentity(
        db,
        "by_provider_client_order_id",
        "providerClientOrderId",
        orderId,
        scope
    )

    if (byProviderClientOrderId) {
        return byProviderClientOrderId
    }

    const bySignedOrderFingerprint = await findScopedOrderByIndexedIdentity(
        db,
        "by_signed_order_fingerprint",
        "signedOrderFingerprint",
        orderId,
        scope
    )

    if (bySignedOrderFingerprint) {
        return bySignedOrderFingerprint
    }

    const byProviderOrderId = await findScopedOrderByIndexedIdentity(
        db,
        "by_provider_order_id",
        "providerOrderId",
        orderId,
        scope
    )

    if (byProviderOrderId) {
        return byProviderOrderId
    }

    return await findOrderRowByAlias(db, {
        app: scope.app!,
        accountId: scope.accountId!,
        strategyId: scope.strategyId,
        alias: orderId,
    })
}

async function findScopedOrderByIndexedIdentity(
    db: DatabaseReader,
    indexName: "by_order_id" | "by_provider_client_order_id" | "by_signed_order_fingerprint" | "by_provider_order_id",
    fieldName: "orderId" | "providerClientOrderId" | "signedOrderFingerprint" | "providerOrderId",
    value: string,
    scope: OrderIdentityLookupScope
): Promise<Doc<"orders"> | null> {
    const query = db
        .query("orders")
        .withIndex(indexName, (q) => q.eq(fieldName, value))

    if (!hasOrderIdentityScope(scope)) {
        return await query.first()
    }

    const orders = await query.collect()
    return orders.find((order) => orderMatchesIdentityScope(order, scope)) ?? null
}

function hasOrderIdentityScope(scope: OrderIdentityLookupScope): boolean {
    return scope.app !== undefined && scope.accountId !== undefined
}

function orderMatchesIdentityScope(
    order: Doc<"orders">,
    scope: OrderIdentityLookupScope
): boolean {
    if (scope.app !== undefined && order.app !== scope.app) {
        return false
    }
    if (scope.accountId !== undefined && order.accountId !== scope.accountId) {
        return false
    }
    if (scope.strategyId !== undefined && order.strategyId !== scope.strategyId) {
        return false
    }

    return true
}
