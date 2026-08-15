import type { OrderOperationContext } from "./execution-contracts"
import type { OrderSnapshot } from "./orders"
import type { Position } from "./types"
import { positionSideForOrderSide, readPositionSide } from "./execution-metadata"
import { resolveProviderPositionId } from "./provider-position-key"

const POSITION_QUANTITY_EPSILON = 1e-9

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

export type SnapshotPositionIdentityResolution =
    | {
        outcome: "resolved"
        providerPositionId: string
        heldSide: Position["side"]
    }
    | {
        outcome: "not_found"
        heldSide: Position["side"]
    }
    | {
        outcome: "ambiguous"
        heldSide: Position["side"]
        candidates: Position[]
    }

function resolveSnapshotHeldPositionSide(
    snapshot: Pick<OrderSnapshot, "intent" | "metadata" | "action">
): Position["side"] {
    const declaredSide = readPositionSide(snapshot.intent.metadata?.positionSide) ??
        readPositionSide(snapshot.metadata?.positionSide)
    if (declaredSide) {
        return declaredSide
    }

    return positionSideForOrderSide(snapshot.intent.side, snapshot.action !== "close")
}

export function resolveSnapshotPositionIdentity(args: {
    snapshot: Pick<OrderSnapshot, "intent" | "metadata" | "action" | "instrument" | "quantity" | "filledQuantity">
    positions: Position[]
}): SnapshotPositionIdentityResolution {
    const heldSide = resolveSnapshotHeldPositionSide(args.snapshot)
    const candidates = args.positions.filter((position) =>
        position.instrument === args.snapshot.instrument &&
        position.side === heldSide &&
        resolveProviderPositionId(position) !== undefined
    )

    if (candidates.length === 0) {
        return {
            outcome: "not_found",
            heldSide,
        }
    }

    const matched = candidates.length === 1
        ? candidates
        : candidates.filter((position) => matchesSnapshotQuantity(position, args.snapshot))

    if (matched.length !== 1) {
        return {
            outcome: "ambiguous",
            heldSide,
            candidates,
        }
    }

    return {
        outcome: "resolved",
        providerPositionId: resolveProviderPositionId(matched[0]!)!,
        heldSide,
    }
}

function matchesSnapshotQuantity(
    position: Position,
    snapshot: Pick<OrderSnapshot, "quantity" | "filledQuantity">
): boolean {
    const ownedQuantity = snapshot.filledQuantity > 0 ? snapshot.filledQuantity : snapshot.quantity
    return Math.abs(position.quantity - ownedQuantity) <= POSITION_QUANTITY_EPSILON
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
