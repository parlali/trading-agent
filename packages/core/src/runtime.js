export function createKillSwitchGuardedVenue(venue, strategyId, checkKillSwitch) {
    return new Proxy(venue, {
        get(target, prop, receiver) {
            if (prop === "submitOrder") {
                return async (...args) => {
                    if (await checkKillSwitch(`pre-order:${strategyId}`)) {
                        throw new Error("Order submission blocked: kill switch is active");
                    }
                    return target.submitOrder(...args);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}
export function startHealthServer(config) {
    Bun.serve({
        port: config.port,
        fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname !== "/health") {
                return new Response("Not Found", { status: 404 });
            }
            return Response.json({
                app: config.appName,
                ...config.getHealth(),
            });
        },
    });
}
export function startHeartbeat(config) {
    const intervalMs = config.intervalMs ?? 30_000;
    let timer = null;
    timer = setInterval(async () => {
        try {
            await config.backend.reportHeartbeat(config.appName, config.isReady() ? "healthy" : "unhealthy", config.getMetadata());
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${config.appName}] Failed to report heartbeat: ${message}`);
        }
    }, intervalMs);
    return {
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
}
export function wireShutdown(config) {
    const shutdown = async () => {
        config.onShutdown?.();
        try {
            await config.backend.reportHeartbeat(config.appName, "unhealthy", {
                reason: "shutdown",
                shutdownAt: Date.now(),
            });
        }
        catch {
            // Best effort
        }
        await config.scheduler.shutdown();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
const KILL_SWITCH_CACHE_TTL = 5000;
export function createKillSwitchChecker(config) {
    let cachedResult = null;
    let cachedAt = 0;
    return async (context) => {
        if (cachedResult !== null && Date.now() - cachedAt < KILL_SWITCH_CACHE_TTL) {
            return cachedResult;
        }
        try {
            const state = await config.backend.getSystemState();
            if (state.globalKillSwitch) {
                config.logger.warn("Global kill switch is active", { context });
                cachedResult = true;
                cachedAt = Date.now();
                return true;
            }
            if (state.appKillSwitches[config.appName.replace(/-/g, "_")]) {
                config.logger.warn("App kill switch is active", { context, app: config.appName });
                cachedResult = true;
                cachedAt = Date.now();
                return true;
            }
            cachedResult = false;
            cachedAt = Date.now();
            return false;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            config.logger.error("Failed to check kill switch -- proceeding with caution", {
                context,
                error: message,
            });
            return false;
        }
    };
}
export function requireResolvedSecret(secrets, primary, fallback) {
    const value = secrets[primary] ?? (fallback ? secrets[fallback] : undefined);
    if (!value) {
        const keys = fallback ? `${primary} (or fallback ${fallback})` : primary;
        throw new Error(`Missing required secret: ${keys}. Set this in Convex environment variables.`);
    }
    return value;
}
export function resolveCredentialPrefix(ref) {
    return ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}
export function createAccountSnapshotPersister(config) {
    return async (accountState) => {
        try {
            await config.backend.snapshotAccountState(config.appName, config.venueName, accountState);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            config.logger.error("Failed to persist account snapshot", { error: message });
        }
    };
}
export function getCurrentTimeInTimezone(timezone) {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        });
        const parts = formatter.formatToParts(new Date());
        const hourPart = parts.find((p) => p.type === "hour");
        const minutePart = parts.find((p) => p.type === "minute");
        return {
            hours: Number(hourPart?.value ?? 0),
            minutes: Number(minutePart?.value ?? 0),
        };
    }
    catch {
        const now = new Date();
        return { hours: now.getUTCHours(), minutes: now.getUTCMinutes() };
    }
}
export function padTime(n) {
    return String(n).padStart(2, "0");
}
