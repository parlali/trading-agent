import { VENUE_META, type VenueApp } from "@/lib/constants"
import { cn } from "@/lib/utils"

export type FreshnessState = {
    provider: VenueApp
    stale: boolean
    lastSyncedAt?: number
    providerStatus?: "healthy" | "degraded" | "unhealthy"
    driftDetected?: boolean
}

export function FreshnessHeader({
    freshness,
    className,
}: {
    freshness?: FreshnessState[]
    className?: string
}) {
    if (!freshness || freshness.length === 0) return null

    const hasIssues = freshness.some(
        (f) => f.stale || f.driftDetected || f.providerStatus !== "healthy",
    )

    if (!hasIssues) return null

    const issueSummary = freshness
        .filter((entry) => entry.stale || entry.driftDetected || entry.providerStatus !== "healthy")
        .map((entry) => {
            const label = VENUE_META[entry.provider].shortLabel
            const reasons: string[] = []

            if (entry.stale) {
                reasons.push("stale")
            }

            if (entry.driftDetected) {
                reasons.push("drift")
            }

            if (!entry.stale && entry.providerStatus === "degraded") {
                reasons.push("degraded")
            }

            if (!entry.stale && entry.providerStatus === "unhealthy") {
                reasons.push("unhealthy")
            }

            return `${label}: ${reasons.join(", ")}`
        })

    return (
        <div
            className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
                hasIssues
                    ? "border-signal-warning/30 bg-signal-warning/5 text-signal-warning"
                    : "border-border bg-muted/50 text-muted-foreground",
                className,
            )}
        >
            <span className="font-medium">Portfolio sync issues detected</span>
            <span className="opacity-80">{issueSummary.join(" | ")}</span>
        </div>
    )
}
