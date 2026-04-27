import type { Position, WorkingOrder } from "./types"

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
