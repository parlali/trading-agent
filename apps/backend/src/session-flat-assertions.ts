import {
    filterWorkingOrdersByOwnershipScope,
    type ProviderOwnershipScope,
    type WorkingOrder,
} from "@valiq-trading/core"

export function findRemainingOwnedWorkingOrdersAfterSessionFlat(
    workingOrders: WorkingOrder[],
    ownershipScope: ProviderOwnershipScope
): WorkingOrder[] {
    return filterWorkingOrdersByOwnershipScope(workingOrders, ownershipScope)
        .filter((order) => order.status === "pending" || order.status === "partially_filled")
}
