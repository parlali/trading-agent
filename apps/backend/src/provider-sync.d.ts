import type { AccountState, Position, VenueAdapter, WorkingOrder } from "@valiq-trading/core";
import type { SyncStrategyEntry } from "./state";
import type { VenueApp } from "./types";
export declare const ACCOUNT_SCOPE: "single-account-per-venue";
export declare function getProviderSyncEntry(app: VenueApp): SyncStrategyEntry | null;
export declare function reconcileProviderPortfolio(args: {
    app: VenueApp;
    venueName: string;
    source: "startup_sync" | "periodic_sync" | "post_run_sync";
    venue: VenueAdapter;
}): Promise<{
    accountState: AccountState;
    positions: Position[];
    workingOrders: WorkingOrder[];
    driftDetected: boolean;
    driftSummary?: string;
}>;
export declare function recordProviderSyncFailure(app: VenueApp, error: string): Promise<void>;
//# sourceMappingURL=provider-sync.d.ts.map