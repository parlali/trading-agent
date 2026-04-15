import { describe, expect, it } from "vitest"

interface StrategyRunRow {
    id: string
    status: "running" | "completed" | "failed"
    startedAt: number
}

interface ProviderRow {
    key: string
    ownershipStatus: "owned" | "unowned" | "orphaned"
    quantity: number
}

function oldRecoverableRunIds(runs: StrategyRunRow[], now: number, olderThanMs: number): string[] {
    return runs
        .filter((run) => run.status === "running")
        .filter((run) => now - run.startedAt > olderThanMs)
        .map((run) => run.id)
        .sort((left, right) => left.localeCompare(right))
}

function newRecoverableRunIds(runs: StrategyRunRow[], now: number, olderThanMs: number): string[] {
    const staleBefore = now - olderThanMs
    return runs
        .filter((run) => run.status === "running")
        .filter((run) => run.startedAt < staleBefore)
        .map((run) => run.id)
        .sort((left, right) => left.localeCompare(right))
}

function oldReplaceSemantics(_existing: ProviderRow[], next: ProviderRow[]): ProviderRow[] {
    return [...next].sort((left, right) => left.key.localeCompare(right.key))
}

function newDiffUpsertSemantics(existing: ProviderRow[], next: ProviderRow[]): ProviderRow[] {
    const current = new Map(existing.map((row) => [row.key, row]))

    for (const row of next) {
        current.set(row.key, row)
    }

    const nextKeys = new Set(next.map((row) => row.key))
    for (const key of Array.from(current.keys())) {
        if (!nextKeys.has(key)) {
            current.delete(key)
        }
    }

    return Array.from(current.values()).sort((left, right) => left.key.localeCompare(right.key))
}

describe("control-plane parity", () => {
    it("keeps stale-run recovery semantics unchanged across full-scan and indexed selection", () => {
        const now = Date.parse("2026-04-15T00:00:00.000Z")
        const olderThanMs = 15 * 60 * 1000
        const runs: StrategyRunRow[] = [
            { id: "run-1", status: "running", startedAt: now - (16 * 60 * 1000) },
            { id: "run-2", status: "running", startedAt: now - (10 * 60 * 1000) },
            { id: "run-3", status: "completed", startedAt: now - (60 * 60 * 1000) },
            { id: "run-4", status: "running", startedAt: now - (15 * 60 * 1000) },
        ]

        expect(newRecoverableRunIds(runs, now, olderThanMs)).toEqual(
            oldRecoverableRunIds(runs, now, olderThanMs)
        )
    })

    it("keeps provider-row final state unchanged between replace and diff/upsert semantics", () => {
        const existing: ProviderRow[] = [
            { key: "A", ownershipStatus: "owned", quantity: 10 },
            { key: "B", ownershipStatus: "unowned", quantity: 5 },
            { key: "C", ownershipStatus: "owned", quantity: 2 },
        ]
        const next: ProviderRow[] = [
            { key: "A", ownershipStatus: "owned", quantity: 10 },
            { key: "B", ownershipStatus: "owned", quantity: 6 },
            { key: "D", ownershipStatus: "orphaned", quantity: 1 },
        ]

        expect(newDiffUpsertSemantics(existing, next)).toEqual(
            oldReplaceSemantics(existing, next)
        )
    })
})
