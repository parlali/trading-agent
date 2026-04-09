import type { VenueAdapter } from "./execution";
import type { AccountState } from "./types";
export declare function createKillSwitchGuardedVenue<T extends VenueAdapter>(venue: T, strategyId: string, checkKillSwitch: (context: string) => Promise<boolean>): T;
export declare function startHealthServer(config: {
    port: number;
    appName: string;
    getHealth: () => Record<string, unknown>;
}): void;
export declare function startHeartbeat(config: {
    appName: string;
    intervalMs?: number;
    backend: {
        reportHeartbeat(app: string, status: string, metadata: Record<string, unknown>): Promise<void>;
    };
    getMetadata: () => Record<string, unknown>;
    isReady: () => boolean;
}): {
    stop: () => void;
};
export declare function wireShutdown(config: {
    appName: string;
    scheduler: {
        shutdown(): Promise<void>;
    };
    backend: {
        reportHeartbeat(app: string, status: string, metadata: Record<string, unknown>): Promise<void>;
    };
    onShutdown?: () => void;
}): void;
export declare function createKillSwitchChecker(config: {
    appName: string;
    backend: {
        getSystemState(): Promise<{
            globalKillSwitch: boolean;
            appKillSwitches: Record<string, boolean>;
        }>;
    };
    logger: {
        warn(msg: string, meta?: Record<string, unknown>): void;
        error(msg: string, meta?: Record<string, unknown>): void;
    };
}): (context: string) => Promise<boolean>;
export declare function requireResolvedSecret(secrets: Record<string, string | null>, primary: string, fallback?: string): string;
export declare function resolveCredentialPrefix(ref: string): string;
export declare function createAccountSnapshotPersister(config: {
    appName: string;
    venueName: string;
    backend: {
        snapshotAccountState(app: string, venue: string, state: AccountState): Promise<void>;
    };
    logger: {
        error(msg: string, meta?: Record<string, unknown>): void;
    };
}): (accountState: AccountState) => Promise<void>;
export declare function getCurrentTimeInTimezone(timezone: string): {
    hours: number;
    minutes: number;
};
export declare function padTime(n: number): string;
//# sourceMappingURL=runtime.d.ts.map