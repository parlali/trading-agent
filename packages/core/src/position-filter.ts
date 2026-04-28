import type { Position, WorkingOrder } from "./types"
import { buildProviderPositionKey, buildProviderWorkingOrderKey } from "./provider-position-key"

export interface ProviderOwnershipScope {
    instruments: Set<string>
    positionKeys: Set<string>
    workingOrderIds: Set<string>
}

export function filterPositionsByOwnership(
    positions: Position[],
    ownedInstruments: Set<string>
): Position[] {
    return positions.filter((position) => ownedInstruments.has(position.instrument))
}

export function filterWorkingOrdersByOwnership(
    orders: WorkingOrder[],
    ownedInstruments: Set<string>
): WorkingOrder[] {
    return orders.filter((order) => ownedInstruments.has(order.instrument))
}

export function filterPositionsByOwnershipScope(
    positions: Position[],
    scope: ProviderOwnershipScope
): Position[] {
    if (scope.positionKeys.size > 0) {
        return positions.filter((position) => scope.positionKeys.has(buildProviderPositionKey(position)))
    }

    return filterPositionsByOwnership(positions, scope.instruments)
}

export function filterWorkingOrdersByOwnershipScope(
    orders: WorkingOrder[],
    scope: ProviderOwnershipScope
): WorkingOrder[] {
    if (scope.workingOrderIds.size > 0) {
        return orders.filter((order) => scope.workingOrderIds.has(buildProviderWorkingOrderKey(order)))
    }

    return filterWorkingOrdersByOwnership(orders, scope.instruments)
}
