import { TrendingUp } from "lucide-react";
import type { Severity } from "@valiq-trading/core";
export type { VenueApp, ActiveVenueApp } from "@valiq-trading/core";
export { VENUE_APPS, ACTIVE_VENUE_APPS } from "@valiq-trading/core";
type VenueMeta = {
    label: string;
    shortLabel: string;
    description: string;
    icon: typeof TrendingUp;
    color: string;
    chartColor: string;
};
export declare const VENUE_META: Record<string, VenueMeta>;
export declare const STALE_THRESHOLD_MS: number;
export declare const STATUS_COLORS: {
    readonly healthy: "text-signal-healthy";
    readonly degraded: "text-signal-warning";
    readonly unhealthy: "text-signal-danger";
    readonly running: "text-signal-warning";
    readonly completed: "text-signal-healthy";
    readonly failed: "text-signal-danger";
};
export declare const SEVERITY_COLORS: Record<Severity, string>;
//# sourceMappingURL=constants.d.ts.map