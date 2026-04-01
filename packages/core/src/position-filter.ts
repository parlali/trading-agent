import type { Position } from "./types"

export function filterPositionsByOwnership(
    positions: Position[],
    ownedInstruments: Set<string>
): Position[] {
    return positions.filter((position) => ownedInstruments.has(position.instrument))
}
