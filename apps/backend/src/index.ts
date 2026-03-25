import {
    ToolRegistry,
    DuckDuckGoSearchProvider,
    createCancelOrderTool,
    createGetAccountTool,
    createGetOrderStatusTool,
    createGetPositionsTool,
    createModifyOrderTool,
    createProposeAdjustmentTool,
    createProposeCloseTool,
    createProposeOrderTool,
    createWaitForOrderUpdateTool,
    createWebFetchTool,
    createWebSearchTool,
    executeAgentRun,
} from "@valiq-trading/agent"
import {
    createConvexOrderPersistenceAdapter,
    createTradingBackendClient,
    toKillSwitchKey,
    type KillSwitchState,
    type StoredStrategy,
} from "@valiq-trading/convex"
import {
    ExecutionPipeline,
    Scheduler,
    createLogger,
    validatePolicy,
    type AccountState,
    type App,
    type VenueAdapter,
} from "@valiq-trading/core"
import { AlpacaPlugin } from "./plugins/alpaca"
import { PolymarketPlugin } from "./plugins/polymarket"
import { MT5Plugin } from "./plugins/mt5"
import type { HealthState, VenueApp, VenuePlugin } from "./types"

const APP_NAME: App = "backend"
const HEARTBEAT_INTERVAL_MS = 30_000
const MANUAL_RUN_POLL_INTERVAL_MS = 5_000
const PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000

declare const Bun: {
    env: Record<string, string | undefined>
    serve(config: {
        port: number
        fetch(request: Request): Response | Promise<Response>
    }): unknown
}

declare const process: {
    on(event: string, listener: () => void): void
    exit(code?: number): void
}

const healthState: HealthState = {
    ready: false,
    startedAt: Date.now(),
    strategyCount: 0,
    venues: {},
}

const logger = createLogger({ app: APP_NAME })
const convexUrl = requireEnv("CONVEX_URL")
const healthPort = Number(Bun.env.HEALTH_PORT ?? 3100)
const backend = createTradingBackendClient(convexUrl)
const searchProvider = new DuckDuckGoSearchProvider()

const plugins: Record<VenueApp, VenuePlugin> = {
    "alpaca-options": new AlpacaPlugin(),
    "polymarket": new PolymarketPlugin(),
    "mt5": new MT5Plugin(),
}

let resolvedSecrets: Record<string, string | null> = {}
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let manualRunPollTimer: ReturnType<typeof setInterval> | null = null
let manualRunPollInFlight = false
let periodicSyncTimer: ReturnType<typeof setInterval> | null = null
let periodicSyncInFlight = false

const syncStrategies: Partial<Record<VenueApp, {
    strategy: StoredStrategy
    policy: Record<string, unknown>
}>> = {}

async function main(): Promise<void> {
    await resolveAllSecrets()
    await validateAllEnvironments()

    const scheduler = new Scheduler({ logger })

    const allApps: VenueApp[] = ["alpaca-options", "polymarket", "mt5"]
    let totalStrategies = 0

    for (const app of allApps) {
        const plugin = plugins[app]
        const strategies = await backend.getStrategyConfigs(app)
        const activeStrategies = strategies.filter((s) => s.enabled)
        totalStrategies += activeStrategies.length

        for (const strategy of activeStrategies) {
            const policy = validatePolicy(app, strategy.policy)

            if (app === "polymarket") {
                const polyPlugin = plugin as PolymarketPlugin
                const additionalKeys = polyPlugin.resolveAdditionalCredentialKeys(policy)
                if (additionalKeys.length > 0) {
                    const additionalSecrets = await backend.resolveSecrets(additionalKeys)
                    polyPlugin.setAdditionalSecrets(additionalSecrets)
                }
            }

            if (!syncStrategies[app]) {
                syncStrategies[app] = { strategy, policy }
            }

            scheduler.register({
                strategyId: strategy._id,
                scheduleType: "cron",
                cronExpression: strategy.schedule,
                handler: async () => {
                    await runStrategy(app, plugin, strategy, policy)
                },
            })
        }

        logger.info(`Loaded ${activeStrategies.length} strategies for ${app}`)
    }

    healthState.strategyCount = totalStrategies

    await performStartupSync()

    startHealthServer(scheduler)
    wireShutdown(scheduler)
    startHeartbeat()
    startManualRunPolling(scheduler)
    startPeriodicSync()

    scheduler.start()
    healthState.ready = true

    await backend.reportHeartbeat(APP_NAME, "healthy", {
        strategyCount: totalStrategies,
        startedAt: healthState.startedAt,
        venues: Object.keys(healthState.venues),
    })

    logger.info("Backend started", {
        strategies: scheduler.getRegisteredStrategies(),
        healthPort,
        totalStrategies,
    })
}

async function resolveAllSecrets(): Promise<void> {
    logger.info("Resolving secrets from Convex environment variables")

    const allKeys = new Set<string>()

    allKeys.add("OPENROUTER_API_KEY")
    allKeys.add("OPENROUTER_MODEL")

    for (const plugin of Object.values(plugins)) {
        for (const key of plugin.resolveSecretKeys()) {
            allKeys.add(key)
        }
    }

    resolvedSecrets = await backend.resolveSecrets(Array.from(allKeys))

    if (!resolvedSecrets.OPENROUTER_API_KEY) {
        throw new Error(
            "Missing required secret: OPENROUTER_API_KEY. Set this in Convex environment variables."
        )
    }

    const resolved = Object.keys(resolvedSecrets).filter((k) => resolvedSecrets[k] !== null)
    const missing = Object.keys(resolvedSecrets).filter((k) => resolvedSecrets[k] === null)

    logger.info("Secrets resolved from Convex", { resolved, missing })
}

async function validateAllEnvironments(): Promise<void> {
    for (const [appKey, plugin] of Object.entries(plugins)) {
        const app = appKey as VenueApp
        try {
            await plugin.validateEnvironment(resolvedSecrets)
            healthState.venues[app] = { validated: true }
            logger.info(`${app} environment validated`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            healthState.venues[app] = { validated: false, error: message }
            logger.error(`${app} environment validation failed`, { error: message })
            await backend.createAlert({
                app,
                severity: "critical",
                message: `${app} environment validation failed at startup: ${message}`,
            })
        }
    }
}

async function checkKillSwitch(app: VenueApp, context: string): Promise<boolean> {
    try {
        const state: KillSwitchState = await backend.getSystemState()

        if (state.globalKillSwitch) {
            logger.warn("Global kill switch is active", { context, app })
            return true
        }

        if (state.appKillSwitches[toKillSwitchKey(app)]) {
            logger.warn("App kill switch is active", { context, app })
            return true
        }

        return false
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to check kill switch -- proceeding with caution", {
            context,
            app,
            error: message,
        })
        return false
    }
}

function createKillSwitchGuardedVenue(
    venue: VenueAdapter,
    app: VenueApp,
    strategyId: string
): VenueAdapter {
    return new Proxy(venue, {
        get(target, prop, receiver) {
            if (prop === "submitOrder") {
                return async (...args: Parameters<typeof target.submitOrder>) => {
                    if (await checkKillSwitch(app, `pre-order:${strategyId}`)) {
                        throw new Error("Order submission blocked: kill switch is active")
                    }
                    return target.submitOrder(...args)
                }
            }
            return Reflect.get(target, prop, receiver)
        },
    })
}

async function runStrategy(
    app: VenueApp,
    plugin: VenuePlugin,
    strategy: StoredStrategy,
    policy: Record<string, unknown>
): Promise<void> {
    if (await checkKillSwitch(app, `pre-run:${strategy._id}`)) {
        logger.warn("Run skipped due to active kill switch", { strategyId: strategy._id, app })
        await backend.createAlert({
            strategyId: strategy._id,
            app,
            severity: "warning",
            message: "Strategy run skipped: kill switch active",
        })
        return
    }

    const venue = plugin.createVenueAdapter(policy, resolvedSecrets)

    if (plugin.preRunHooks) {
        const hookResult = await plugin.preRunHooks({
            venue,
            policy,
            strategyId: strategy._id,
            logger,
            createAlert: (alert) => backend.createAlert(alert),
        })
        if (hookResult.skip) {
            logger.warn("Pre-run hook skipped strategy", {
                strategyId: strategy._id,
                app,
                reason: hookResult.reason,
            })
            return
        }
    }

    const runId = await backend.createRun(strategy._id, app)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
        app,
    })

    const orderPersistence = createConvexOrderPersistenceAdapter({ url: convexUrl })
    const guardedVenue = createKillSwitchGuardedVenue(venue, app, strategy._id)

    const pipeline = new ExecutionPipeline({
        venue: guardedVenue,
        venueName: plugin.venueName,
        policy,
        riskValidators: plugin.getRiskValidators(),
        logger: runLogger,
        tradeEventLogger: backend,
        orderPersistence,
        runId,
        strategyId: strategy._id,
    })

    const tools = new ToolRegistry()

    const extraTools = plugin.getExtraTools({
        secrets: resolvedSecrets,
        runLogger,
    })
    for (const tool of extraTools) {
        tools.register(tool)
    }

    tools.register(createGetPositionsTool(pipeline))
    tools.register(createGetAccountTool(pipeline))
    tools.register(createProposeOrderTool(pipeline))
    tools.register(createProposeAdjustmentTool(pipeline))
    tools.register(createProposeCloseTool(pipeline))
    tools.register(createGetOrderStatusTool(pipeline))
    tools.register(createCancelOrderTool(pipeline))
    tools.register(createModifyOrderTool(pipeline))
    tools.register(createWaitForOrderUpdateTool(pipeline))
    tools.register(createWebSearchTool(searchProvider))
    tools.register(createWebFetchTool())

    try {
        const positions = await venue.getPositions()
        const accountState = await venue.getAccountState()

        const result = await executeAgentRun(
            {
                runId,
                strategyId: strategy._id,
                app,
                timestamp: Date.now(),
                positions,
                accountState,
                policy,
                context: strategy.context,
            },
            {
                llm: {
                    apiKey: resolvedSecrets.OPENROUTER_API_KEY!,
                    model: resolvedSecrets.OPENROUTER_MODEL ?? "anthropic/claude-3.7-sonnet",
                },
                tools,
                logger: runLogger,
                agentLogger: backend,
            }
        )

        const syncedPositions = await venue.getPositions()
        await backend.syncPositions(strategy._id, app, syncedPositions)

        const finalAccountState = await venue.getAccountState()
        await persistAccountSnapshot(app, plugin.venueName, finalAccountState)

        if (plugin.postRunHooks) {
            await plugin.postRunHooks({
                venue,
                policy,
                strategyId: strategy._id,
                logger: runLogger,
                createAlert: (alert) => backend.createAlert(alert),
            })
        }

        if (result.error) {
            await backend.updateRun(runId, "failed", result.summary, result.error)
            updateHealth("failed", result.summary, result.error)
            return
        }

        await backend.updateRun(runId, "completed", result.summary)
        updateHealth("completed", result.summary)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await backend.updateRun(runId, "failed", undefined, message)
        updateHealth("failed", undefined, message)

        try {
            const failureAccountState = await venue.getAccountState()
            await persistAccountSnapshot(app, plugin.venueName, failureAccountState)
        } catch {
            // Cannot reach venue for snapshot
        }

        throw error
    } finally {
        pipeline.stopAllTracking()
    }
}

async function persistAccountSnapshot(
    app: VenueApp,
    venueName: string,
    accountState: AccountState
): Promise<void> {
    try {
        await backend.snapshotAccountState(app, venueName, accountState)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to persist account snapshot", { app, error: message })
    }
}

function startHeartbeat(): void {
    heartbeatTimer = setInterval(async () => {
        try {
            await backend.reportHeartbeat(APP_NAME, healthState.ready ? "healthy" : "unhealthy", {
                strategyCount: healthState.strategyCount,
                venues: healthState.venues,
                lastRunAt: healthState.lastRunAt,
                lastRunStatus: healthState.lastRunStatus,
                uptime: Date.now() - healthState.startedAt,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Failed to report heartbeat", { error: message })
        }
    }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
    }
}

function startManualRunPolling(scheduler: Scheduler): void {
    manualRunPollTimer = setInterval(async () => {
        if (manualRunPollInFlight) {
            return
        }

        manualRunPollInFlight = true

        try {
            await pollManualRunRequests(scheduler)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Failed to poll manual run requests", { error: message })
        } finally {
            manualRunPollInFlight = false
        }
    }, MANUAL_RUN_POLL_INTERVAL_MS)
}

function stopManualRunPolling(): void {
    if (manualRunPollTimer) {
        clearInterval(manualRunPollTimer)
        manualRunPollTimer = null
    }
}

async function pollManualRunRequests(scheduler: Scheduler): Promise<void> {
    const apps: VenueApp[] = ["alpaca-options", "polymarket", "mt5"]

    for (const app of apps) {
        const requests = await backend.getManualRunRequests(app)

        for (const request of requests) {
            try {
                await scheduler.triggerManual(request.strategyId)
            } finally {
                await backend.clearManualRunRequest(request._id)
            }
        }
    }
}

async function performStartupSync(): Promise<void> {
    logger.info("Performing startup sync for validated venues")

    for (const [appKey, entry] of Object.entries(syncStrategies)) {
        const app = appKey as VenueApp
        const plugin = plugins[app]

        if (!healthState.venues[app]?.validated) {
            logger.warn(`Skipping startup sync for ${app}: environment not validated`)
            continue
        }

        try {
            const venue = plugin.createVenueAdapter(entry.policy, resolvedSecrets)
            const accountState = await venue.getAccountState()
            await persistAccountSnapshot(app, plugin.venueName, accountState)

            const positions = await venue.getPositions()
            await backend.syncPositions(entry.strategy._id, app, positions)

            healthState.venues[app] = {
                ...healthState.venues[app],
                validated: true,
                lastSyncAt: Date.now(),
            }

            await backend.reportHeartbeat(app, "healthy", {
                source: "startup_sync",
                positionCount: positions.length,
                balance: accountState.balance,
            })

            logger.info(`Startup sync completed for ${app}`, {
                balance: accountState.balance,
                positions: positions.length,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`Startup sync failed for ${app}`, { error: message })

            healthState.venues[app] = {
                ...healthState.venues[app],
                validated: healthState.venues[app]?.validated ?? false,
                lastSyncError: message,
            }

            await backend.reportHeartbeat(app, "degraded", {
                error: message,
                source: "startup_sync",
            })
        }
    }
}

function startPeriodicSync(): void {
    periodicSyncTimer = setInterval(async () => {
        if (periodicSyncInFlight) return
        periodicSyncInFlight = true

        try {
            await performPeriodicSync()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Periodic sync iteration failed", { error: message })
        } finally {
            periodicSyncInFlight = false
        }
    }, PERIODIC_SYNC_INTERVAL_MS)
}

function stopPeriodicSync(): void {
    if (periodicSyncTimer) {
        clearInterval(periodicSyncTimer)
        periodicSyncTimer = null
    }
}

async function performPeriodicSync(): Promise<void> {
    for (const [appKey, entry] of Object.entries(syncStrategies)) {
        const app = appKey as VenueApp
        const plugin = plugins[app]

        if (!healthState.venues[app]?.validated) continue

        try {
            const venue = plugin.createVenueAdapter(entry.policy, resolvedSecrets)
            const accountState = await venue.getAccountState()
            await persistAccountSnapshot(app, plugin.venueName, accountState)

            const positions = await venue.getPositions()
            await backend.syncPositions(entry.strategy._id, app, positions)

            healthState.venues[app] = {
                ...healthState.venues[app],
                validated: true,
                lastSyncAt: Date.now(),
                lastSyncError: undefined,
            }

            await backend.reportHeartbeat(app, "healthy", {
                source: "periodic_sync",
                positionCount: positions.length,
                balance: accountState.balance,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`Periodic sync failed for ${app}`, { error: message })

            healthState.venues[app] = {
                ...healthState.venues[app],
                validated: healthState.venues[app]?.validated ?? false,
                lastSyncAt: Date.now(),
                lastSyncError: message,
            }

            await backend.reportHeartbeat(app, "degraded", {
                error: message,
                source: "periodic_sync",
            })

            await backend.createAlert({
                app,
                severity: "warning",
                message: `Periodic sync failed for ${app}: ${message}`,
            })
        }
    }
}

function startHealthServer(scheduler: Scheduler): void {
    Bun.serve({
        port: healthPort,
        fetch(request) {
            const { pathname } = new URL(request.url)

            if (pathname !== "/health") {
                return new Response("Not Found", { status: 404 })
            }

            return Response.json({
                app: APP_NAME,
                ready: healthState.ready,
                startedAt: healthState.startedAt,
                strategyCount: healthState.strategyCount,
                venues: healthState.venues,
                registeredStrategies: scheduler.getRegisteredStrategies(),
                lastRunAt: healthState.lastRunAt,
                lastRunStatus: healthState.lastRunStatus,
                lastRunSummary: healthState.lastRunSummary,
                lastRunError: healthState.lastRunError,
            })
        },
    })
}

function wireShutdown(scheduler: Scheduler): void {
    const shutdown = async () => {
        healthState.ready = false
        stopHeartbeat()
        stopManualRunPolling()
        stopPeriodicSync()

        try {
            await backend.reportHeartbeat(APP_NAME, "unhealthy", {
                reason: "shutdown",
                shutdownAt: Date.now(),
            })
        } catch {
            // Best effort
        }

        await scheduler.shutdown()
        process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
}

function updateHealth(
    status: "completed" | "failed",
    summary?: string,
    error?: string
): void {
    healthState.lastRunAt = Date.now()
    healthState.lastRunStatus = status
    healthState.lastRunSummary = summary
    healthState.lastRunError = error
}

function requireEnv(name: string): string {
    const value = Bun.env[name]
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

await main()
