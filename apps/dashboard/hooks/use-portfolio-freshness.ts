"use client"

import { useMemo } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { FreshnessState } from "@/components/portfolio"
import type { VenueApp } from "@/lib/constants"

export function usePortfolioFreshness(provider: VenueApp | null): FreshnessState[] | undefined {
    const freshness = useQuery(api.queries.getPortfolioFreshness, {})

    return useMemo(() => {
        const states = freshness?.map((entry) => ({
            provider: entry.app as VenueApp,
            stale: entry.stale,
            lastSyncedAt: entry.lastSyncedAt,
            providerStatus: entry.providerStatus === "stale"
                ? "unhealthy"
                : entry.providerStatus as "healthy" | "degraded" | "unhealthy",
            driftDetected: entry.driftDetected,
        }))

        if (!states) {
            return undefined
        }

        if (!provider) {
            return states
        }

        return states.filter((state) => state.provider === provider)
    }, [freshness, provider])
}
