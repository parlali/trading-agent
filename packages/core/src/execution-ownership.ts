import type { ExecutionResult } from "./types"
import type { OrderSnapshot } from "./orders"

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
        if (isOwnershipActiveStatus(currentSnapshot.status)) {
            ownedInstruments.add(currentSnapshot.instrument)
            return
        }

        if (isOwnershipActiveStatus(previousSnapshot.status)) {
            ownedInstruments.delete(currentSnapshot.instrument)
        }
    }
}

function isOwnershipActiveStatus(status: ExecutionResult["status"]): boolean {
    return status === "pending" || status === "partially_filled" || status === "filled"
}
