import type { ExecutionResult, OrderIntent, Position } from "./types"
import type { OrderSnapshot } from "./orders"
import type { ProviderOwnershipScope } from "./position-filter"
import { positionSideForOrderSide } from "./execution-metadata"
import { readSnapshotProviderPositionId } from "./execution-order-operation-context"
import {
    buildProviderPositionKey,
    buildProviderPositionKeyAliases,
    resolveProviderPositionId,
} from "./provider-position-key"

const OWNERSHIP_QUANTITY_EPSILON = 1e-9

export function updateOwnedInstrumentsFromResult(
    ownedInstruments: Set<string> | null,
    action: string,
    instrument: string,
    result: ExecutionResult
): void {
    if (!ownedInstruments) {
        return
    }

    if (action === "entry" || action === "adjustment") {
        if (isOwnershipActiveStatus(result.status)) {
            ownedInstruments.add(instrument)
        }
    }
}

export function reconcileOwnedInstrumentsFromSnapshots(
    ownedInstruments: Set<string> | null,
    previousSnapshot: OrderSnapshot,
    currentSnapshot: OrderSnapshot
): void {
    if (!ownedInstruments) {
        return
    }

    if (currentSnapshot.action === "entry" || currentSnapshot.action === "adjustment") {
        if (isOwnershipActiveSnapshot(currentSnapshot)) {
            ownedInstruments.add(currentSnapshot.instrument)
            return
        }

        if (isOwnershipActiveSnapshot(previousSnapshot)) {
            ownedInstruments.delete(currentSnapshot.instrument)
        }
    }
}

export function updateOwnershipScopeFromResult(
    scope: ProviderOwnershipScope | null,
    action: string,
    intent: Pick<OrderIntent, "instrument" | "side">,
    result: ExecutionResult
): void {
    if (!scope) {
        return
    }

    if (action !== "entry" && action !== "adjustment") {
        return
    }

    if (!isOwnershipFilledStatus(result.status) && result.filledQuantity <= 0) {
        return
    }

    recordOpenedPositionInScope(scope, {
        instrument: intent.instrument,
        side: positionSideForOrderSide(intent.side, true),
        providerPositionId: resolveProviderPositionId({
            metadata: result.intentUpdates?.metadata,
        }),
    })
}

export function reconcileOwnershipScopeFromSnapshot(
    scope: ProviderOwnershipScope | null,
    snapshot: OrderSnapshot
): void {
    if (!scope) {
        return
    }

    if (snapshot.action !== "entry" && snapshot.action !== "adjustment") {
        return
    }

    if (!isOwnershipFilledStatus(snapshot.status) && snapshot.filledQuantity <= 0) {
        return
    }

    recordOpenedPositionInScope(scope, {
        instrument: snapshot.instrument,
        side: positionSideForOrderSide(snapshot.intent.side, true),
        providerPositionId: readSnapshotProviderPositionId(snapshot),
    })
}

export function releaseClosedPositionFromOwnershipScope(
    scope: ProviderOwnershipScope | null,
    args: {
        position: Position
        closeQuantity: number
        result: ExecutionResult
    }
): void {
    if (!scope || args.result.status !== "filled") {
        return
    }

    const closedQuantity = args.result.filledQuantity > 0
        ? args.result.filledQuantity
        : args.closeQuantity
    if (closedQuantity + OWNERSHIP_QUANTITY_EPSILON < args.position.quantity) {
        return
    }

    for (const key of buildProviderPositionKeyAliases(args.position)) {
        scope.positionKeys.delete(key)
    }
}

function recordOpenedPositionInScope(
    scope: ProviderOwnershipScope,
    opened: {
        instrument: string
        side: Position["side"]
        providerPositionId: string | undefined
    }
): void {
    scope.instruments.add(opened.instrument)
    if (opened.providerPositionId) {
        scope.positionKeys.add(buildProviderPositionKey(opened))
        return
    }

    if (!scope.instrumentFallbackUnlocks) {
        scope.instrumentFallbackUnlocks = new Set<string>()
    }
    scope.instrumentFallbackUnlocks.add(opened.instrument)
}

function isOwnershipFilledStatus(status: ExecutionResult["status"]): boolean {
    return status === "filled" || status === "partially_filled"
}

function isOwnershipActiveStatus(status: ExecutionResult["status"]): boolean {
    return status === "pending" || status === "partially_filled" || status === "filled"
}

function isOwnershipActiveSnapshot(snapshot: OrderSnapshot): boolean {
    return isOwnershipActiveStatus(snapshot.status) || snapshot.filledQuantity > 0
}
