import type { DatabaseReader } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"

export async function findOrderRowByIdentity(
    db: DatabaseReader,
    orderId: string
): Promise<Doc<"orders"> | null> {
    const byCanonicalId = await db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", orderId))
        .first()

    if (byCanonicalId) {
        return byCanonicalId
    }

    const byProviderClientOrderId = await db
        .query("orders")
        .withIndex("by_provider_client_order_id", (q) => q.eq("providerClientOrderId", orderId))
        .first()

    if (byProviderClientOrderId) {
        return byProviderClientOrderId
    }

    const bySignedOrderFingerprint = await db
        .query("orders")
        .withIndex("by_signed_order_fingerprint", (q) => q.eq("signedOrderFingerprint", orderId))
        .first()

    if (bySignedOrderFingerprint) {
        return bySignedOrderFingerprint
    }

    const byProviderOrderId = await db
        .query("orders")
        .withIndex("by_provider_order_id", (q) => q.eq("providerOrderId", orderId))
        .first()

    if (byProviderOrderId) {
        return byProviderOrderId
    }

    const orders = await db
        .query("orders")
        .collect()

    return orders.find((order) => (order.providerOrderAliases ?? []).includes(orderId)) ?? null
}
