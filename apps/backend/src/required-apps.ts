import type { PortfolioFreshnessRow } from "@valiq-trading/convex"
import type { VenueApp } from "./types"

export type RequiredVenueFreshness = Pick<
    PortfolioFreshnessRow,
    "app" |
    "lastSyncedAt" |
    "lastVerifiedAt" |
    "providerStatus" |
    "stale" |
    "driftDetected" |
    "lastError" |
    "lastDriftSummary" |
    "positionCount" |
    "pendingOrderCount"
>

function hasPersistedProviderState(
    freshness: RequiredVenueFreshness | undefined
): boolean {
    if (!freshness) {
        return false
    }

    return (
        freshness.lastSyncedAt !== undefined ||
        freshness.lastVerifiedAt !== undefined ||
        freshness.lastError !== undefined ||
        freshness.lastDriftSummary !== undefined ||
        freshness.driftDetected ||
        freshness.positionCount > 0 ||
        freshness.pendingOrderCount > 0
    )
}

function requiresVenueMonitoring(
    strategyCount: number,
    freshness: RequiredVenueFreshness | undefined
): boolean {
    if (strategyCount > 0) {
        return true
    }

    if (!freshness || !hasPersistedProviderState(freshness)) {
        return false
    }

    return (
        freshness.positionCount > 0 ||
        freshness.pendingOrderCount > 0 ||
        freshness.stale ||
        freshness.providerStatus !== "healthy" ||
        freshness.driftDetected ||
        freshness.lastError !== undefined
    )
}

export function getRequiredVenueApps<T>(
    apps: VenueApp[],
    syncStrategies: Partial<Record<VenueApp, T[]>>,
    providerFreshness: readonly RequiredVenueFreshness[] = []
): VenueApp[] {
    const freshnessByApp = new Map(
        providerFreshness.map((entry) => [entry.app, entry])
    )

    return apps.filter((app) =>
        requiresVenueMonitoring(
            syncStrategies[app]?.length ?? 0,
            freshnessByApp.get(app)
        )
    )
}
