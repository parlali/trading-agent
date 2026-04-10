import type { VenueApp, VenueHealthState, VenuePlugin } from "./types"

export interface EnvironmentValidationDependencies {
    createAlert(args: {
        strategyId?: string
        app?: string
        severity: "critical" | "warning" | "info"
        message: string
    }): Promise<void>
    getPlugin(app: VenueApp): VenuePlugin | undefined
    getRequiredApps(apps: VenueApp[]): Promise<VenueApp[]>
    getValidationSecrets(app: VenueApp): Record<string, string | null>
    healthState: {
        venues: Record<string, VenueHealthState>
    }
    logger: {
        error(message: string, metadata?: Record<string, unknown>): void
        info(message: string, metadata?: Record<string, unknown>): void
    }
    reportHeartbeat(
        app: string,
        status: "healthy" | "degraded" | "unhealthy",
        metadata?: Record<string, unknown>
    ): Promise<void>
}

function shouldValidateVenueEnvironment(venueState: VenueHealthState | undefined): boolean {
    return venueState?.validated !== true
}

export async function validateVenueEnvironments(
    apps: VenueApp[],
    dependencies: EnvironmentValidationDependencies
): Promise<void> {
    const requiredApps = new Set(await dependencies.getRequiredApps(apps))

    for (const app of apps) {
        if (!requiredApps.has(app)) {
            delete dependencies.healthState.venues[app]
            continue
        }

        const venueState = dependencies.healthState.venues[app]
        if (!shouldValidateVenueEnvironment(venueState)) {
            continue
        }

        const plugin = dependencies.getPlugin(app)
        if (!plugin) {
            continue
        }

        const validationSecrets = dependencies.getValidationSecrets(app)

        try {
            await plugin.validateEnvironment(validationSecrets)
            dependencies.healthState.venues[app] = { validated: true }
            dependencies.logger.info(`${app} environment validated`)

            await dependencies.reportHeartbeat(app, "healthy", {
                source: "environment_validation",
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const previousError = dependencies.healthState.venues[app]?.error
            dependencies.healthState.venues[app] = {
                validated: false,
                error: message,
            }
            dependencies.logger.error(`${app} environment validation failed`, {
                error: message,
            })

            await dependencies.reportHeartbeat(app, "degraded", {
                source: "environment_validation",
                error: message,
            })

            if (previousError !== message) {
                await dependencies.createAlert({
                    app,
                    severity: "critical",
                    message: `${app} environment validation failed: ${message}`,
                })
            }
        }
    }
}
