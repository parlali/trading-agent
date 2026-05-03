import {
    filterPositionsByOwnershipScope,
    filterWorkingOrdersByOwnershipScope,
    type Position,
    type ProviderOwnershipScope,
    type WorkingOrder,
} from "@valiq-trading/core"

export function findRemainingOwnedPositionsAfterSessionFlat(
    positions: Position[],
    ownershipScope: ProviderOwnershipScope
): Position[] {
    return filterPositionsByOwnershipScope(positions, ownershipScope)
        .filter((position) => position.quantity > 0)
}

export function findRemainingOwnedWorkingOrdersAfterSessionFlat(
    workingOrders: WorkingOrder[],
    ownershipScope: ProviderOwnershipScope
): WorkingOrder[] {
    return filterWorkingOrdersByOwnershipScope(workingOrders, ownershipScope)
        .filter((order) => order.status === "pending" || order.status === "partially_filled")
}
