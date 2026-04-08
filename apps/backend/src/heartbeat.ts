import {
    APP_NAME,
    HEARTBEAT_INTERVAL_MS,
    backend,
    healthState,
    logger,
    heartbeatTimer,
    setHeartbeatTimer,
} from "./state"
import type { VenueApp } from "./types"

export function startHeartbeat(): void {
    setHeartbeatTimer(setInterval(async () => {
        try {
            await backend.reportHeartbeat(APP_NAME, healthState.ready ? "healthy" : "unhealthy", {
                strategyCount: healthState.strategyCount,
                venues: healthState.venues,
                lastRunAt: healthState.lastRunAt,
                lastRunStatus: healthState.lastRunStatus,
                uptime: Date.now() - healthState.startedAt,
            })

            for (const [app, venueState] of Object.entries(healthState.venues) as [VenueApp, typeof healthState.venues[string]][]) {
                const status = venueState?.providerStatus === "healthy" && venueState?.validated
                    ? "healthy"
                    : "degraded"
                await backend.reportHeartbeat(app, status, {
                    source: "periodic",
                    lastSyncAt: venueState?.lastSyncAt,
                    lastVerifiedAt: venueState?.lastVerifiedAt,
                    stale: venueState?.stale,
                    driftDetected: venueState?.driftDetected,
                    positionCount: venueState?.positionCount,
                    pendingOrderCount: venueState?.pendingOrderCount,
                    error: venueState?.lastSyncError ?? venueState?.error,
                })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Failed to report heartbeat", { error: message })
        }
    }, HEARTBEAT_INTERVAL_MS))
}

export function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        setHeartbeatTimer(null)
    }
}
