import { DuckDuckGoSearchProvider } from "@valiq-trading/agent";
import { type App } from "@valiq-trading/core";
import { type StoredStrategy } from "@valiq-trading/convex";
import type { HealthState, VenueApp, VenuePlugin } from "./types";
export declare const APP_NAME: App;
export declare const HEARTBEAT_INTERVAL_MS = 30000;
export declare const MANUAL_RUN_POLL_INTERVAL_MS = 5000;
export declare const PERIODIC_SYNC_INTERVAL_MS: number;
export declare function requireEnv(name: string): string;
export declare const healthState: HealthState;
export declare const logger: import("@valiq-trading/core").Logger;
export declare const convexUrl: string;
export declare const backendServiceToken: string;
export declare const healthPort: number;
export declare const backend: import("@valiq-trading/convex").TradingBackendClient;
export declare const searchProvider: DuckDuckGoSearchProvider;
export declare const plugins: Partial<Record<VenueApp, VenuePlugin>>;
export declare let resolvedSecrets: Record<string, string | null>;
export declare function setResolvedSecrets(secrets: Record<string, string | null>): void;
export declare let heartbeatTimer: ReturnType<typeof setInterval> | null;
export declare function setHeartbeatTimer(timer: ReturnType<typeof setInterval> | null): void;
export declare let manualRunPollTimer: ReturnType<typeof setInterval> | null;
export declare function setManualRunPollTimer(timer: ReturnType<typeof setInterval> | null): void;
export declare let manualRunPollInFlight: boolean;
export declare function setManualRunPollInFlight(value: boolean): void;
export declare let periodicSyncTimer: ReturnType<typeof setInterval> | null;
export declare function setPeriodicSyncTimer(timer: ReturnType<typeof setInterval> | null): void;
export declare let periodicSyncInFlight: boolean;
export declare function setPeriodicSyncInFlight(value: boolean): void;
export declare const killSwitchCheckers: Partial<Record<VenueApp, (context: string) => Promise<boolean>>>;
export interface SyncStrategyEntry {
    strategy: StoredStrategy;
    policy: Record<string, unknown>;
    secrets: Record<string, string | null>;
}
export declare const syncStrategies: Partial<Record<VenueApp, SyncStrategyEntry[]>>;
export declare const ALL_APPS: VenueApp[];
//# sourceMappingURL=state.d.ts.map