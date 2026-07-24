import type {
    StoredAccount,
    StoredStrategy,
} from "@valiq-trading/convex"
import type { VenueApp } from "./types"

export interface SyncStrategyEntry {
    strategy: StoredStrategy
    account: StoredAccount
    policy: Record<string, unknown>
    secrets: Record<string, string | null>
}

export const syncStrategies: Partial<Record<VenueApp, SyncStrategyEntry[]>> = {}
