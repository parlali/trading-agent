import {
    backend,
    healthState,
    logger,
    plugins,
    setResolvedSecrets,
    syncStrategies,
} from "../state"
import type { App } from "@valiq-trading/core"
import { STRATEGY_LLM_PROVIDER_SECRET_KEYS } from "../scheduler-provider-gates"
import type { VenueApp } from "../types"
import { writeHeartbeatSnapshot } from "../health-write"

export async function resolveAllSecrets(): Promise<void> {
    logger.info("Resolving secrets from Convex environment variables")

    const allKeys = new Set<string>()

    for (const key of STRATEGY_LLM_PROVIDER_SECRET_KEYS) {
        allKeys.add(key)
    }

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
        logger.warn(
            "OPENROUTER_API_KEY is missing. OpenRouter strategy runs will fail until this is set in Convex environment variables."
        )
    }
}

export async function validateAllEnvironments(apps: VenueApp[]): Promise<void> {

    for (const app of apps) {
        const plugin = plugins[app]
        if (!plugin) {
            continue
        }

        const entries = syncStrategies[app] ?? []
        if (entries.length === 0) {
            continue
        }

        let appValidated = true
        const failedAccounts: Array<{
            accountId: string
            label: string
            error: string
        }> = []
        const accounts = {
            ...(healthState.venues[app]?.accounts ?? {}),
        }

        for (const entry of entries) {
            const accountId = entry.account.accountId
            try {
                await plugin.validateEnvironment(entry.secrets)
                accounts[accountId] = {
                    ...accounts[accountId],
                    label: entry.account.label,
                    validated: true,
                    error: undefined,
                    lastValidatedAt: Date.now(),
                }
                logger.info(`${app} account environment validated`, {
                    accountId,
                    accountLabel: entry.account.label,
                })
            } catch (error) {
                appValidated = false
                const message = error instanceof Error ? error.message : String(error)
                const previousError = accounts[accountId]?.error
                failedAccounts.push({
                    accountId,
                    label: entry.account.label,
                    error: message,
                })
                accounts[accountId] = {
                    ...accounts[accountId],
                    label: entry.account.label,
                    validated: false,
                    error: message,
                    lastValidatedAt: Date.now(),
                }
                logger.error(`${app} account environment validation failed`, {
                    accountId,
                    accountLabel: entry.account.label,
                    error: message,
                })

                if (previousError !== message) {
                    await backend.createAlert({
                        app,
                        severity: "critical",
                        message: `${app}:${accountId} environment validation failed: ${message}`,
                    })
                }
            }
        }

        healthState.venues[app] = {
            ...healthState.venues[app],
            validated: appValidated,
            error: appValidated ? undefined : `${app} has account validation failures`,
            accounts,
        }

        await writeHeartbeatSnapshot({
            app: app as App,
            status: appValidated ? "healthy" : "degraded",
            metadata: {
                source: "environment_validation",
                accountCount: entries.length,
                validatedAccounts: Object.values(accounts).filter((account) => account.validated).length,
                failedAccounts,
            },
        })
    }

}
