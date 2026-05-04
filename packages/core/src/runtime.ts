import { toVenueKillSwitchKey, type VenueApp } from "./app-types"
import type { VenueAdapter } from "./execution"
import type { BunServeRuntime, ProcessSignalRuntime } from "./runtime-globals"
import type { AccountState } from "./types"
export {
    getCurrentTimeInTimezone,
    isWithinSessionFlatWindow,
    padTime,
} from "./runtime-time"

declare const Bun: BunServeRuntime

declare const process: ProcessSignalRuntime

export function createKillSwitchGuardedVenue<T extends VenueAdapter>(
    venue: T,
    strategyId: string,
    checkKillSwitch: (context: string) => Promise<boolean>
): T {
    return new Proxy(venue, {
        get(target, prop, receiver) {
            if (prop === "submitOrder") {
                return async (...args: Parameters<typeof target.submitOrder>) => {
                    if (await checkKillSwitch(`pre-order:${strategyId}`)) {
                        throw new Error("Order submission blocked: kill switch is active")
                    }
                    return target.submitOrder(...args)
                }
            }
            return Reflect.get(target, prop, receiver)
        },
    }) as T
}

export function startHealthServer(config: {
    port: number
    appName: string
    getHealth: () => Record<string, unknown>
}): void {
    Bun.serve({
        port: config.port,
        fetch(request) {
            const { pathname } = new URL(request.url)

            if (pathname !== "/health") {
                return new Response("Not Found", { status: 404 })
            }

            return Response.json({
                app: config.appName,
                ...config.getHealth(),
            })
        },
    })
}

export function startHeartbeat(config: {
    appName: string
    intervalMs?: number
    backend: { reportHeartbeat(app: string, status: string, metadata: Record<string, unknown>): Promise<void> }
    getMetadata: () => Record<string, unknown>
    isReady: () => boolean
}): { stop: () => void } {
    const intervalMs = config.intervalMs ?? 30_000
    let timer: ReturnType<typeof setInterval> | null = null

    timer = setInterval(async () => {
        try {
            await config.backend.reportHeartbeat(
                config.appName,
                config.isReady() ? "healthy" : "unhealthy",
                config.getMetadata()
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[${config.appName}] Failed to report heartbeat: ${message}`)
        }
    }, intervalMs)

    return {
        stop() {
            if (timer) {
                clearInterval(timer)
                timer = null
            }
        },
    }
}

export function wireShutdown(config: {
    appName: string
    scheduler: { shutdown(): Promise<void> }
    backend: { reportHeartbeat(app: string, status: string, metadata: Record<string, unknown>): Promise<void> }
    onShutdown?: () => void
}): void {
    const shutdown = async () => {
        config.onShutdown?.()

        try {
            await config.backend.reportHeartbeat(config.appName, "unhealthy", {
                reason: "shutdown",
                shutdownAt: Date.now(),
            })
        } catch {}

        await config.scheduler.shutdown()
        process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
}

const KILL_SWITCH_CACHE_TTL = 5000

export function createKillSwitchChecker(config: {
    appName: VenueApp
    backend: { getSystemState(): Promise<{ globalKillSwitch: boolean; appKillSwitches: Record<string, boolean> }> }
    logger: { warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void }
}): (context: string) => Promise<boolean> {
    let cachedResult: boolean | null = null
    let cachedAt = 0

    return async (context: string): Promise<boolean> => {
        if (cachedResult !== null && Date.now() - cachedAt < KILL_SWITCH_CACHE_TTL) {
            return cachedResult
        }

        try {
            const state = await config.backend.getSystemState()

            if (state.globalKillSwitch) {
                config.logger.warn("Global kill switch is active", { context })
                cachedResult = true
                cachedAt = Date.now()
                return true
            }

            if (state.appKillSwitches[toVenueKillSwitchKey(config.appName)]) {
                config.logger.warn("App kill switch is active", { context, app: config.appName })
                cachedResult = true
                cachedAt = Date.now()
                return true
            }

            cachedResult = false
            cachedAt = Date.now()
            return false
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            config.logger.error("Failed to check kill switch -- proceeding with caution", {
                context,
                error: message,
            })
            return false
        }
    }
}

export function requireResolvedSecret(
    secrets: Record<string, string | null>,
    primary: string,
    fallback?: string
): string {
    const value = secrets[primary] ?? (fallback ? secrets[fallback] : undefined)
    if (!value) {
        const keys = fallback ? `${primary} (or fallback ${fallback})` : primary
        throw new Error(
            `Missing required secret: ${keys}. Set this in Convex environment variables.`
        )
    }
    return value
}

export function resolveCredentialPrefix(ref: string): string {
    return ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
}

export function createAccountSnapshotPersister(config: {
    appName: string
    venueName: string
    backend: { snapshotAccountState(app: string, venue: string, state: AccountState): Promise<void> }
    logger: { error(msg: string, meta?: Record<string, unknown>): void }
}): (accountState: AccountState) => Promise<void> {
    return async (accountState: AccountState): Promise<void> => {
        try {
            await config.backend.snapshotAccountState(config.appName, config.venueName, accountState)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            config.logger.error("Failed to persist account snapshot", { error: message })
        }
    }
}
