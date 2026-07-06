import type { RiskValidator } from "./risk-types"
import { openIntentRiskValidator } from "./risk"
import { resolveRiskWindowStarts } from "./risk-governance"

const ENTRY_BUDGET_CONSUMING_STATUSES = new Set(["pending", "filled", "partially_filled"])

export interface EntryBudgetOrderRecord {
    action: string
    status: string
    instrument: string
    submittedAt: number
}

export interface EntryBudgetCounts {
    total: number
    byInstrument: Map<string, number>
    weekStartAt: number
}

export function computeWeekEntryCounts(args: {
    orders: EntryBudgetOrderRecord[]
    timezone: string
    timestamp: number
}): EntryBudgetCounts {
    const { weekStartAt } = resolveRiskWindowStarts(args.timestamp, args.timezone)
    const byInstrument = new Map<string, number>()
    let total = 0

    for (const order of args.orders) {
        if (order.action !== "entry" || order.submittedAt < weekStartAt) {
            continue
        }
        if (!ENTRY_BUDGET_CONSUMING_STATUSES.has(order.status)) {
            continue
        }
        total++
        byInstrument.set(order.instrument, (byInstrument.get(order.instrument) ?? 0) + 1)
    }

    return { total, byInstrument, weekStartAt }
}

export function createEntryBudgetValidator(args: {
    maxEntriesPerWeek?: number
    maxEntriesPerInstrumentPerWeek?: number
    counts: EntryBudgetCounts
}): RiskValidator | undefined {
    const { maxEntriesPerWeek, maxEntriesPerInstrumentPerWeek } = args
    if (maxEntriesPerWeek === undefined && maxEntriesPerInstrumentPerWeek === undefined) {
        return undefined
    }

    let total = args.counts.total
    const byInstrument = new Map(args.counts.byInstrument)

    return openIntentRiskValidator((intent) => {
        if (maxEntriesPerWeek !== undefined && total >= maxEntriesPerWeek) {
            return {
                allowed: false,
                reason: `Weekly entry budget exhausted: ${total} of ${maxEntriesPerWeek} entries used since the week started. No further entries this week; manage existing positions only.`,
            }
        }

        const instrumentCount = byInstrument.get(intent.instrument) ?? 0
        if (
            maxEntriesPerInstrumentPerWeek !== undefined &&
            instrumentCount >= maxEntriesPerInstrumentPerWeek
        ) {
            return {
                allowed: false,
                reason: `Weekly per-instrument entry budget exhausted for ${intent.instrument}: ${instrumentCount} of ${maxEntriesPerInstrumentPerWeek} entries used since the week started. Pick a different market or wait for the weekly reset.`,
            }
        }

        total++
        byInstrument.set(intent.instrument, instrumentCount + 1)
        return { allowed: true }
    })
}
