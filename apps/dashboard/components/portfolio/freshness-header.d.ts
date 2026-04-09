export type FreshnessState = {
    provider: string;
    stale: boolean;
    lastSyncedAt?: number;
    providerStatus?: "healthy" | "degraded" | "unhealthy";
    driftDetected?: boolean;
};
export declare function FreshnessHeader({ freshness, className, }: {
    freshness?: FreshnessState[];
    className?: string;
}): import("react").JSX.Element | null;
//# sourceMappingURL=freshness-header.d.ts.map