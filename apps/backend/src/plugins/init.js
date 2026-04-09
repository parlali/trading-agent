import { backend, healthState, logger, plugins, resolvedSecrets, setResolvedSecrets, syncStrategies, } from "../state";
export async function resolveAllSecrets() {
    logger.info("Resolving secrets from Convex environment variables");
    const allKeys = new Set();
    allKeys.add("OPENROUTER_API_KEY");
    for (const plugin of Object.values(plugins)) {
        for (const key of plugin.resolveSecretKeys()) {
            allKeys.add(key);
        }
    }
    const secrets = await backend.resolveSecrets(Array.from(allKeys));
    setResolvedSecrets(secrets);
    const resolved = Object.keys(secrets).filter((k) => secrets[k] !== null);
    const missing = Object.keys(secrets).filter((k) => secrets[k] === null);
    logger.info("Secrets resolved from Convex", { resolved, missing });
    if (missing.length > 0) {
        logger.warn("Some secrets are missing from Convex environment variables", { missing });
    }
    if (!secrets.OPENROUTER_API_KEY) {
        logger.error("OPENROUTER_API_KEY is missing. Agent runs will fail until this is set in Convex environment variables.");
    }
}
export async function validateAllEnvironments(apps) {
    for (const app of apps) {
        const plugin = plugins[app];
        if (!plugin)
            continue;
        const validationSecrets = syncStrategies[app]?.[0]?.secrets ?? resolvedSecrets;
        try {
            await plugin.validateEnvironment(validationSecrets);
            healthState.venues[app] = { validated: true };
            logger.info(`${app} environment validated`);
            await backend.reportHeartbeat(app, "healthy", {
                source: "environment_validation",
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            healthState.venues[app] = { validated: false, error: message };
            logger.error(`${app} environment validation failed`, { error: message });
            await backend.reportHeartbeat(app, "degraded", {
                source: "environment_validation",
                error: message,
            });
            await backend.createAlert({
                app,
                severity: "critical",
                message: `${app} environment validation failed at startup: ${message}`,
            });
        }
    }
}
