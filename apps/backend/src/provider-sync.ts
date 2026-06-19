import type { AccountState, Position, VenueAdapter, WorkingOrder } from "@valiq-trading/core"
import {
    backend,
    healthState,
    logger,
} from "./state"
import type { AccountHealthState, VenueApp } from "./types"
import { readProviderPortfolioForSync } from "./provider-portfolio-read"
import {
    runProviderAccountOperation,
    type ProviderAccountOperationResult,
} from "./provider-account-coordinator"

type ProviderSyncResult = {
    accountState: AccountState
    positions: Position[]
    workingOrders: WorkingOrder[]
    driftDetected: boolean
    driftSummary?: string
}

export async function reconcileProviderPortfolio(args: {
    app: VenueApp
    accountId: string
    venueName: string
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    venue: VenueAdapter
}): Promise<ProviderSyncResult> {
    const result = await runReconcileProviderPortfolio(args, false)
    if (result.status === "skipped") {
        throw new Error(result.reason)
    }

    return result.value
}

export async function reconcileProviderPortfolioIfIdle(args: {
    app: VenueApp
    accountId: string
    venueName: string
    source: "periodic_sync"
    venue: VenueAdapter
}): Promise<ProviderAccountOperationResult<ProviderSyncResult>> {
    return await runReconcileProviderPortfolio(args, true)
}

async function runReconcileProviderPortfolio(args: {
    app: VenueApp
    accountId: string
    venueName: string
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    venue: VenueAdapter
}, skipIfBusy: boolean): Promise<ProviderAccountOperationResult<ProviderSyncResult>> {
    return await runProviderAccountOperation({
        app: args.app,
        accountId: args.accountId,
        source: args.source,
        label: `provider reconciliation ${args.source}`,
        logger,
        skipIfBusy,
    }, async () => await executeProviderPortfolioReconciliation(args))
}

async function executeProviderPortfolioReconciliation(args: {
    app: VenueApp
    accountId: string
    venueName: string
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    venue: VenueAdapter
}): Promise<ProviderSyncResult> {
    const {
        accountState,
        positions,
        workingOrders,
        positionClosures,
        accountPnlEvents,
    } = await readProviderPortfolioForSync(args.app, args.venue)

    const reconciliation = await backend.reconcileProviderPortfolio(
        args.app,
        args.accountId,
        args.venueName,
        args.source,
        accountState,
        positions,
        workingOrders,
        positionClosures,
        accountPnlEvents
    )

    const venueHealth = healthState.venues[args.app]
    const accounts = {
        ...(venueHealth?.accounts ?? {}),
        [args.accountId]: {
            ...(venueHealth?.accounts?.[args.accountId] ?? {}),
            validated: true,
            lastSyncAt: Date.now(),
            lastVerifiedAt: Date.now(),
            providerStatus: reconciliation.driftDetected ? "degraded" as const : "healthy" as const,
            stale: false,
            driftDetected: reconciliation.driftDetected,
            positionCount: reconciliation.positionCount,
            pendingOrderCount: reconciliation.pendingOrderCount,
            lastSyncError: undefined,
        },
    }
    healthState.venues[args.app] = {
        ...venueHealth,
        validated: true,
        accounts,
        lastSyncAt: Date.now(),
        lastVerifiedAt: Date.now(),
        ...rollUpVenueAccountHealth(accounts),
    }

    return {
        accountState,
        positions,
        workingOrders,
        driftDetected: reconciliation.driftDetected,
        driftSummary: reconciliation.driftSummary,
    }
}

function rollUpVenueAccountHealth(accounts: Record<string, AccountHealthState>): {
    providerStatus: "healthy" | "degraded"
    stale: boolean
    driftDetected: boolean
    positionCount: number
    pendingOrderCount: number
    lastSyncError?: string
} {
    const states = Object.values(accounts)
    const degraded = states.some((account) =>
        account.providerStatus === "degraded" || account.providerStatus === "stale"
    )

    return {
        providerStatus: degraded ? "degraded" : "healthy",
        stale: states.some((account) => account.stale === true),
        driftDetected: states.some((account) => account.driftDetected === true),
        positionCount: states.reduce((sum, account) => sum + (account.positionCount ?? 0), 0),
        pendingOrderCount: states.reduce((sum, account) => sum + (account.pendingOrderCount ?? 0), 0),
        lastSyncError: states.map((account) => account.lastSyncError).find((error) => error !== undefined),
    }
}

export async function recordProviderSyncFailure(
    app: VenueApp,
    accountId: string,
    error: string
): Promise<void> {
    try {
        await backend.recordProviderSyncFailure(app, accountId, error)
    } catch (failure) {
        logger.error("Failed to persist provider sync failure", {
            app,
            accountId,
            error: failure instanceof Error ? failure.message : String(failure),
        })
    }

    const venueHealth = healthState.venues[app]
    const accounts = {
        ...(venueHealth?.accounts ?? {}),
        [accountId]: {
            ...(venueHealth?.accounts?.[accountId] ?? {}),
            validated: venueHealth?.accounts?.[accountId]?.validated ?? false,
            providerStatus: "degraded" as const,
            stale: true,
            lastSyncError: error,
        },
    }
    healthState.venues[app] = {
        ...venueHealth,
        validated: venueHealth?.validated ?? false,
        accounts,
        ...rollUpVenueAccountHealth(accounts),
    }
}
