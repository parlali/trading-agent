import {
    ALL_APPS,
    APP_NAME,
    HEARTBEAT_INTERVAL_MS,
    backend,
    healthState,
    logger,
    heartbeatTimer,
    setHeartbeatTimer,
    syncStrategies,
} from "./state"
import { getRequiredVenueApps } from "./required-apps"
import { writeHeartbeatLiveness } from "./health-write"

export function startHeartbeat(): void {
    setHeartbeatTimer(setInterval(async () => {
        try {
            await writeHeartbeatLiveness({
                app: APP_NAME,
                status: healthState.ready ? "healthy" : "unhealthy",
                metadata: {
                    source: "periodic",
                },
            })

            const requiredApps = getRequiredVenueApps(
                ALL_APPS,
                syncStrategies,
                await backend.getPortfolioFreshness()
            )

            for (const app of requiredApps) {
                const venueState = healthState.venues[app]
                const status = venueState?.providerStatus === "healthy" && venueState?.validated
                    ? "healthy"
                    : "degraded"
                await writeHeartbeatLiveness({
                    app,
                    status,
                    metadata: {
                        source: "periodic",
                    },
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
