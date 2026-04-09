"use client";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@valiq-trading/convex";
export function usePortfolioFreshness(provider) {
    const freshness = useQuery(api.queries.getPortfolioFreshness, {});
    return useMemo(() => {
        const states = freshness?.map((entry) => ({
            provider: entry.app,
            stale: entry.stale,
            lastSyncedAt: entry.lastSyncedAt,
            providerStatus: entry.providerStatus === "stale"
                ? "unhealthy"
                : entry.providerStatus,
            driftDetected: entry.driftDetected,
        }));
        if (!states) {
            return undefined;
        }
        if (!provider) {
            return states;
        }
        return states.filter((state) => state.provider === provider);
    }, [freshness, provider]);
}
