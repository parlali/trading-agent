import { mt5PolicySchema } from "@valiq-trading/core"
import type { StoredStrategy } from "@valiq-trading/convex"
import {
    normalizeMT5Symbol,
    resolveMT5ConfiguredSymbols,
} from "@valiq-trading/mt5"

export interface MT5ConfiguredInstrumentAssignment {
    accountId: string
    strategyId: string
    strategyName: string
    instrument: string
}

export interface MT5ConfiguredInstrumentConflict {
    accountId: string
    instrument: string
    strategies: MT5ConfiguredInstrumentAssignment[]
}

export function findMT5ConfiguredInstrumentConflicts(
    strategies: StoredStrategy[]
): MT5ConfiguredInstrumentConflict[] {
    const assignmentsByScope = new Map<string, MT5ConfiguredInstrumentAssignment[]>()

    for (const strategy of strategies) {
        if (!isEnabledLiveMT5Strategy(strategy)) {
            continue
        }

        const policy = mt5PolicySchema.parse(strategy.policy)
        for (const instrument of resolveMT5ConfiguredSymbols(policy)) {
            const normalizedInstrument = normalizeMT5Symbol(instrument)
            const key = `${strategy.accountId}\u0000${normalizedInstrument}`
            const assignments = assignmentsByScope.get(key) ?? []
            assignments.push({
                accountId: strategy.accountId,
                strategyId: String(strategy._id),
                strategyName: strategy.name,
                instrument,
            })
            assignmentsByScope.set(key, assignments)
        }
    }

    const conflicts: MT5ConfiguredInstrumentConflict[] = []
    for (const assignments of assignmentsByScope.values()) {
        if (assignments.length <= 1) {
            continue
        }

        const first = assignments[0]!
        conflicts.push({
            accountId: first.accountId,
            instrument: normalizeMT5Symbol(first.instrument),
            strategies: assignments.sort((left, right) =>
                left.strategyName.localeCompare(right.strategyName) ||
                left.strategyId.localeCompare(right.strategyId)
            ),
        })
    }

    return conflicts.sort((left, right) =>
        left.accountId.localeCompare(right.accountId) ||
        left.instrument.localeCompare(right.instrument)
    )
}

export function assertNoMT5ConfiguredInstrumentConflicts(
    strategies: StoredStrategy[]
): void {
    const conflicts = findMT5ConfiguredInstrumentConflicts(strategies)
    if (conflicts.length === 0) {
        return
    }

    throw new Error(formatMT5ConfiguredInstrumentConflict(conflicts[0]!))
}

export function formatMT5ConfiguredInstrumentConflict(
    conflict: MT5ConfiguredInstrumentConflict
): string {
    const strategyList = conflict.strategies
        .map((strategy) => `${strategy.strategyName} (${strategy.strategyId})`)
        .join(", ")

    return `MT5 configured instrument conflict: account ${conflict.accountId} instrument ${conflict.instrument} is enabled in multiple live strategies: ${strategyList}. MT5 accounting requires one live strategy per account/instrument.`
}

function isEnabledLiveMT5Strategy(strategy: StoredStrategy): boolean {
    if (strategy.app !== "mt5" || strategy.enabled !== true) {
        return false
    }

    return strategy.policy?.dryRun !== true
}
