import { backend, healthState, logger, syncStrategies, } from "./state";
export const ACCOUNT_SCOPE = "single-account-per-venue";
export function getProviderSyncEntry(app) {
    const entries = syncStrategies[app] ?? [];
    if (entries.length > 1) {
        logger.info("Provider sync is operating under the single-account-per-venue assumption", {
            app,
            accountScope: ACCOUNT_SCOPE,
            strategyCount: entries.length,
        });
    }
    return entries[0] ?? null;
}
export async function reconcileProviderPortfolio(args) {
    const [accountState, positions, workingOrders] = await Promise.all([
        args.venue.getAccountState(),
        args.venue.getPositions(),
        args.venue.getWorkingOrders ? args.venue.getWorkingOrders() : Promise.resolve([]),
    ]);
    const reconciliation = await backend.reconcileProviderPortfolio(args.app, args.venueName, args.source, accountState, positions, workingOrders);
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
    };
    return {
        accountState,
        positions,
        workingOrders,
        driftDetected: reconciliation.driftDetected,
        driftSummary: reconciliation.driftSummary,
    };
}
export async function recordProviderSyncFailure(app, error) {
    try {
        await backend.recordProviderSyncFailure(app, error);
    }
    catch (failure) {
        logger.error("Failed to persist provider sync failure", {
            app,
            error: failure instanceof Error ? failure.message : String(failure),
        });
    }
    healthState.venues[app] = {
        ...healthState.venues[app],
        validated: healthState.venues[app]?.validated ?? false,
        providerStatus: "degraded",
        stale: true,
        lastSyncError: error,
    };
}
