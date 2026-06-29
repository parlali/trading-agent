import type { Position, WorkingOrder } from "./types"
import {
    buildProviderPositionKeyAliases,
    buildProviderWorkingOrderKey,
} from "./provider-position-key"

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
        return positions.filter((position) =>
            buildProviderPositionKeyAliases(position).some((key) => scope.positionKeys.has(key)) ||
            (
                scope.instruments.has(position.instrument) &&
                !hasScopedPositionKeyForInstrument(scope, position.instrument)
            )
        )
    }

    return filterPositionsByOwnership(positions, scope.instruments)
}

export function filterWorkingOrdersByOwnershipScope(
    orders: WorkingOrder[],
    scope: ProviderOwnershipScope
): WorkingOrder[] {
    if (scope.workingOrderIds.size > 0) {
        return orders.filter((order) =>
            scope.workingOrderIds.has(buildProviderWorkingOrderKey(order)) ||
            (
                scope.instruments.has(order.instrument) &&
                !hasScopedWorkingOrderIdForInstrument(scope, order.instrument)
            )
        )
    }

    return filterWorkingOrdersByOwnership(orders, scope.instruments)
}

function hasScopedPositionKeyForInstrument(
    scope: ProviderOwnershipScope,
    instrument: string
): boolean {
    const prefix = `${instrument}:`
    for (const key of scope.positionKeys) {
        if (key.startsWith(prefix)) {
            return true
        }
    }

    return false
}

function hasScopedWorkingOrderIdForInstrument(
    scope: ProviderOwnershipScope,
    instrument: string
): boolean {
    const prefixes = [
        `${instrument}:`,
        `order:${instrument}:`,
        `algo:${instrument}:`,
    ]

    for (const key of scope.workingOrderIds) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
            return true
        }
    }

    return false
}
