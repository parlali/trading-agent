import type { StoredStrategy } from "@valiq-trading/convex";
import { type Scheduler } from "@valiq-trading/core";
import type { RunTrigger } from "@valiq-trading/convex";
import type { VenueApp, VenuePlugin } from "./types";
export declare const pendingManualTriggers: Set<string>;
export declare function updateHealth(status: "completed" | "failed", summary?: string, error?: string): void;
export declare function registerStrategyWithScheduler(scheduler: Scheduler, app: VenueApp, strategy: StoredStrategy): Promise<void>;
export declare function runStrategy(app: VenueApp, plugin: VenuePlugin, strategy: StoredStrategy, policy: Record<string, unknown>, strategySecrets: Record<string, string | null>, scheduler?: Scheduler, trigger?: RunTrigger): Promise<void>;
//# sourceMappingURL=scheduler.d.ts.map