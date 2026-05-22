import type { AccountState, Position, VenueAdapter, WorkingOrder } from "@valiq-trading/core"
import {
    backend,
    healthState,
    logger,
    resolvedSecrets,
    syncStrategies,
} from "./state"
import type { SyncStrategyEntry } from "./state"
import type { VenueApp } from "./types"
import { readProviderPortfolioForSync } from "./provider-portfolio-read"

export const ACCOUNT_SCOPE = "single-account-per-venue" as const

export function getProviderSyncEntry(app: VenueApp): SyncStrategyEntry | null {
    const entries = syncStrategies[app] ?? []
    if (entries.length > 1) {
        logger.info("Provider sync is operating under the single-account-per-venue assumption", {
            app,
            accountScope: ACCOUNT_SCOPE,
            strategyCount: entries.length,
        })
    }
    return entries[0] ?? null
}

export function getProviderSyncConfig(app: VenueApp): {
    policy: Record<string, unknown>
    secrets: Record<string, string | null>
} {
    const entry = getProviderSyncEntry(app)
    if (entry) {
        return {
            policy: entry.policy,
            secrets: entry.secrets,
        }
    }

    logger.info("Provider sync is using runtime venue secrets without a strategy entry", {
        app,
        accountScope: ACCOUNT_SCOPE,
    })

    return {
        policy: {},
        secrets: resolvedSecrets,
    }
}

export async function reconcileProviderPortfolio(args: {
    app: VenueApp
    venueName: string
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    venue: VenueAdapter
}): Promise<{
    accountState: AccountState
    positions: Position[]
    workingOrders: WorkingOrder[]
    driftDetected: boolean
    driftSummary?: string
}> {
    const {
        accountState,
        positions,
        workingOrders,
        positionClosures,
    } = await readProviderPortfolioForSync(args.app, args.venue)

    const reconciliation = await backend.reconcileProviderPortfolio(
        args.app,
        args.venueName,
        args.source,
        accountState,
        positions,
        workingOrders,
        positionClosures
    )

    healthState.venues[args.app] = {
        ...healthState.venues[args.app],
        validated: true,
        lastSyncAt: Date.now(),
        lastVerifiedAt: Date.now(),
        providerStatus: reconciliation.driftDetected ? "degraded" : "healthy",
        stale: false,
        driftDetected: reconciliation.driftDetected,
        positionCount: reconciliation.positionCount,
        pendingOrderCount: reconciliation.pendingOrderCount,
        lastSyncError: undefined,
    }

    return {
        accountState,
        positions,
        workingOrders,
        driftDetected: reconciliation.driftDetected,
        driftSummary: reconciliation.driftSummary,
    }
}

export async function recordProviderSyncFailure(
    app: VenueApp,
    error: string
): Promise<void> {
    try {
        await backend.recordProviderSyncFailure(app, error)
    } catch (failure) {
        logger.error("Failed to persist provider sync failure", {
            app,
            error: failure instanceof Error ? failure.message : String(failure),
        })
    }

    healthState.venues[app] = {
        ...healthState.venues[app],
        validated: healthState.venues[app]?.validated ?? false,
        providerStatus: "degraded",
        stale: true,
        lastSyncError: error,
    }
}
