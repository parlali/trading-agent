import type { Position, WorkingOrder } from "./types"
import {
    buildProviderPositionKeyAliases,
    buildProviderWorkingOrderKey,
} from "./provider-position-key"

export interface ProviderOwnershipScope {
    instruments: Set<string>
    positionKeys: Set<string>
    workingOrderIds: Set<string>
    instrumentFallbackUnlocks?: Set<string>
    foreignPositionKeys?: Set<string>
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
    return positions.filter((position) => {
        const aliases = buildProviderPositionKeyAliases(position)
        if (aliases.some((key) => scope.positionKeys.has(key))) {
            return true
        }

        if (!scope.instruments.has(position.instrument)) {
            return false
        }

        if (aliases.some((key) => scope.foreignPositionKeys?.has(key))) {
            return false
        }

        return scope.positionKeys.size === 0 ||
            allowsInstrumentFallback(scope, position.instrument)
    })
}

export function collectForeignProviderPositionKeys(
    providerPositions: Position[],
    ownedPositions: Position[]
): Set<string> {
    const ownedKeys = new Set<string>()
    for (const position of ownedPositions) {
        for (const key of buildProviderPositionKeyAliases(position)) {
            ownedKeys.add(key)
        }
    }

    const foreignKeys = new Set<string>()
    for (const position of providerPositions) {
        const aliases = buildProviderPositionKeyAliases(position)
        if (aliases.some((key) => ownedKeys.has(key))) {
            continue
        }

        for (const key of aliases) {
            foreignKeys.add(key)
        }
    }

    return foreignKeys
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

function allowsInstrumentFallback(
    scope: ProviderOwnershipScope,
    instrument: string
): boolean {
    return scope.instrumentFallbackUnlocks?.has(instrument) === true ||
        !hasScopedPositionKeyForInstrument(scope, instrument)
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
