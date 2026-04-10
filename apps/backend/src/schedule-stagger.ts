import { cronMatchesDate } from "@valiq-trading/core"
import type { StoredStrategy } from "@valiq-trading/convex"
import type { SyncStrategyEntry } from "./state"
import type { VenueApp } from "./types"

const POLYMARKET_CRON_STAGGER_DELAY_MS = 15_000

export function getCronStartDelayMs(
    app: VenueApp,
    strategy: Pick<StoredStrategy, "_id" | "schedule" | "name">,
    entries: SyncStrategyEntry[],
    runAt: Date = new Date()
): number {
    if (app !== "polymarket") {
        return 0
    }

    const scheduledPeers = entries
        .map((entry) => entry.strategy)
        .filter((candidate) => cronMatchesDate(candidate.schedule, runAt))
        .sort((left, right) => {
            const byName = left.name.localeCompare(right.name)
            return byName !== 0
                ? byName
                : String(left._id).localeCompare(String(right._id))
        })

    const index = scheduledPeers.findIndex((candidate) => candidate._id === strategy._id)
    if (index <= 0) {
        return 0
    }

    return index * POLYMARKET_CRON_STAGGER_DELAY_MS
}
