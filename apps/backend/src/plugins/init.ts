import {
    backend,
    healthState,
    logger,
    plugins,
    resolvedSecrets,
    setResolvedSecrets,
    syncStrategies,
} from "../state"
import type { App } from "@valiq-trading/core"
import {
    validateVenueEnvironments,
    type EnvironmentValidationDependencies,
} from "../environment-validation"
import { getRequiredVenueApps } from "../required-apps"
import type { VenueApp } from "../types"
import { writeHeartbeatSnapshot } from "../health-write"

export async function resolveAllSecrets(): Promise<void> {
    logger.info("Resolving secrets from Convex environment variables")

    const allKeys = new Set<string>()

    allKeys.add("OPENROUTER_API_KEY")

    for (const plugin of Object.values(plugins)) {
        for (const key of plugin.resolveSecretKeys()) {
            allKeys.add(key)
        }
    }

    const secrets = await backend.resolveSecrets(Array.from(allKeys))
    setResolvedSecrets(secrets)

    const resolved = Object.keys(secrets).filter((k) => secrets[k] !== null)
    const missing = Object.keys(secrets).filter((k) => secrets[k] === null)

    logger.info("Secrets resolved from Convex", { resolved, missing })

    if (missing.length > 0) {
        logger.warn("Some secrets are missing from Convex environment variables", { missing })
    }

    if (!secrets.OPENROUTER_API_KEY) {
        logger.error(
            "OPENROUTER_API_KEY is missing. Agent runs will fail until this is set in Convex environment variables."
        )
    }
}

const defaultValidationDependencies: EnvironmentValidationDependencies = {
    createAlert: backend.createAlert.bind(backend),
    getPlugin(app) {
        return plugins[app]
    },
    async getRequiredApps(apps) {
        return getRequiredVenueApps(apps, syncStrategies, await backend.getPortfolioFreshness())
    },
    getValidationSecrets(app) {
        return syncStrategies[app]?.[0]?.secrets ?? resolvedSecrets
    },
    healthState,
    logger,
    reportHeartbeat: async (app, status, metadata) => {
        await writeHeartbeatSnapshot({
            app: app as App,
            status,
            metadata: metadata ?? {
                source: "environment_validation",
            },
        })
    },
}

export async function validateAllEnvironments(
    apps: VenueApp[],
    dependencies: EnvironmentValidationDependencies = defaultValidationDependencies
): Promise<void> {
    await validateVenueEnvironments(apps, dependencies)
}
