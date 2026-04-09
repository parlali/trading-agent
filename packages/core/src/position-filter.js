export function filterPositionsByOwnership(positions, ownedInstruments) {
    return positions.filter((position) => ownedInstruments.has(position.instrument));
}
