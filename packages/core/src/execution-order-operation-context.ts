import type { OrderOperationContext } from "./execution-contracts"
import type { OrderSnapshot } from "./orders"

export function createOrderOperationContext(snapshot: OrderSnapshot): OrderOperationContext {
    const providerPositionId = readSnapshotProviderPositionId(snapshot)

    return {
        canonicalOrderId: snapshot.orderId,
        providerOrderId: snapshot.providerOrderId,
        providerClientOrderId: snapshot.providerClientOrderId,
        providerOrderAliases: snapshot.providerOrderAliases,
        signedOrderFingerprint: snapshot.signedOrderFingerprint,
        operationTarget: resolveSnapshotOperationTarget(snapshot),
        providerPositionId,
        instrument: snapshot.instrument,
        orderStatus: snapshot.status,
    }
}

export function resolveSnapshotOperationTarget(
    snapshot: Pick<OrderSnapshot, "status">
): OrderOperationContext["operationTarget"] {
    if (snapshot.status === "pending") {
        return "working_order"
    }

    if (snapshot.status === "filled") {
        return "position"
    }

    return undefined
}

export function readSnapshotProviderPositionId(
    snapshot: Pick<OrderSnapshot, "intent" | "metadata">
): string | undefined {
    return readMetadataString(snapshot.intent.metadata?.providerPositionId) ??
        readMetadataString(snapshot.intent.metadata?.positionId) ??
        readMetadataString(snapshot.intent.metadata?.identifier) ??
        readMetadataString(snapshot.metadata?.providerPositionId) ??
        readMetadataString(snapshot.metadata?.positionId) ??
        readMetadataString(snapshot.metadata?.identifier)
}

function readMetadataString(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : undefined
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value)
    }

    return undefined
}
