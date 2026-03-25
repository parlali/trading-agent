/**
 * MT5 TS orchestrator entry point.
 *
 * Architecture: This process loads strategy configs from Convex, schedules
 * agent runs, and delegates all MT5 broker operations to the Python worker
 * via HTTP. The Python worker owns the MT5 SDK connection and runs on a
 * Windows machine.
 *
 * Key differences from Alpaca/Polymarket:
 * - MT5 orders are market orders that fill immediately (simpler lifecycle)
 * - Trading hours enforcement is critical (no overnight holds)
 * - Emergency flatten: code closes all positions before cutoff regardless
 *   of agent opinion
 * - Venue adapter connects to a remote Python worker, not a REST API directly
 */

import {
    ToolRegistry,
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
    mt5PolicySchema,
    validatePolicy,
    type AccountState,
    type MT5Policy,
} from "@valiq-trading/core"
import {
    ValiqClient,
    ValiqDataAdapter,
    ValiqResearchAdapter,
    createValiqDataTool,
    createValiqResearchTool,
} from "@valiq-trading/valiq"
import { MT5Client, type MT5WorkerCredentials } from "./mt5-client"
import { mt5RiskValidators } from "./risk-rules"
import { MT5VenueAdapter } from "./venue-adapter"
import { DuckDuckGoSearchProvider } from "./web-search"

const APP_NAME = "mt5" as const
const HEARTBEAT_INTERVAL_MS = 30_000

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

interface RuntimeConfig {
    convexUrl: string
    healthPort: number
}

interface HealthState {
    ready: boolean
    startedAt: number
    strategyCount: number
    lastRunAt?: number
    lastRunStatus?: "completed" | "failed"
    lastRunSummary?: string
    lastRunError?: string
}

const healthState: HealthState = {
    ready: false,
    startedAt: Date.now(),
    strategyCount: 0,
}

const logger = createLogger({
    app: APP_NAME,
})

const runtimeConfig = loadRuntimeConfig()
const backend = createTradingBackendClient(runtimeConfig.convexUrl)
const searchProvider = new DuckDuckGoSearchProvider()

let resolvedSecrets: Record<string, string | null> = {}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    await resolveAllSecrets()
    await validateEnvironment()

    const scheduler = new Scheduler({ logger })

    const strategies = await backend.getStrategyConfigs(APP_NAME)
    const activeStrategies = strategies.filter((strategy) => strategy.enabled)
    healthState.strategyCount = activeStrategies.length

    for (const strategy of activeStrategies) {
        const policy = validatePolicy(APP_NAME, strategy.policy)

        scheduler.register({
            strategyId: strategy._id,
            scheduleType: "cron",
            cronExpression: strategy.schedule,
            handler: async () => {
                await runStrategy(strategy, policy)
            },
        })
    }

    startHealthServer(runtimeConfig.healthPort, scheduler)
    wireShutdown(scheduler)
    startHeartbeat()

    scheduler.start()
    healthState.ready = true

    await backend.reportHeartbeat(APP_NAME, "healthy", {
        strategyCount: activeStrategies.length,
        startedAt: healthState.startedAt,
    })

    logger.info("MT5 app started", {
        strategies: scheduler.getRegisteredStrategies(),
        healthPort: runtimeConfig.healthPort,
    })
}

// ---------------------------------------------------------------------------
// Secret resolution from Convex env vars
// ---------------------------------------------------------------------------

async function resolveAllSecrets(): Promise<void> {
    logger.info("Resolving secrets from Convex environment variables")

    const secretKeys = [
        "MT5_WORKER_URL",
        "MT5_WORKER_ACCESS_KEY",
        "MT5_PRIMARY_LOGIN",
        "MT5_PRIMARY_PASSWORD",
        "MT5_PRIMARY_SERVER",
        "MT5_LOGIN",
        "MT5_PASSWORD",
        "MT5_SERVER",
        "OPENROUTER_API_KEY",
        "OPENROUTER_MODEL",
        "VALIQ_API_URL",
        "VALIQ_AUTH_TOKEN",
    ]

    resolvedSecrets = await backend.resolveSecrets(secretKeys)

    const requiredSecrets = ["OPENROUTER_API_KEY", "VALIQ_API_URL", "VALIQ_AUTH_TOKEN", "MT5_WORKER_URL"]
    const missing = requiredSecrets.filter((key) => !resolvedSecrets[key])

    if (missing.length > 0) {
        throw new Error(
            `Missing required secrets in Convex environment variables: ${missing.join(", ")}. ` +
            `Set these using the Convex dashboard or CLI.`
        )
    }

    logger.info("Secrets resolved from Convex", {
        resolved: Object.keys(resolvedSecrets).filter((key) => resolvedSecrets[key] !== null),
        missing: Object.keys(resolvedSecrets).filter((key) => resolvedSecrets[key] === null),
    })
}

function requireResolvedSecret(primary: string, fallback: string): string {
    const value = resolvedSecrets[primary] ?? resolvedSecrets[fallback]
    if (!value) {
        throw new Error(
            `Missing required secret: ${primary} (or fallback ${fallback}). ` +
            `Set this in Convex environment variables.`
        )
    }
    return value
}

function resolveMT5Credentials(policy: Record<string, unknown>): {
    workerUrl: string
    accessKey: string
    credentials: MT5WorkerCredentials
} {
    const credentialsRef = String(policy.credentialsRef ?? "").trim()
    const prefix = credentialsRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

    return {
        workerUrl: resolvedSecrets.MT5_WORKER_URL!,
        accessKey: resolvedSecrets.MT5_WORKER_ACCESS_KEY ?? "",
        credentials: {
            login: Number(requireResolvedSecret(`MT5_${prefix}_LOGIN`, "MT5_LOGIN")),
            password: requireResolvedSecret(`MT5_${prefix}_PASSWORD`, "MT5_PASSWORD"),
            server: requireResolvedSecret(`MT5_${prefix}_SERVER`, "MT5_SERVER"),
        },
    }
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

async function validateEnvironment(): Promise<void> {
    logger.info("Validating MT5 environment connectivity")

    const strategies = await backend.getStrategyConfigs(APP_NAME)
    const firstEnabled = strategies.find((strategy) => strategy.enabled)

    if (!firstEnabled) {
        logger.warn("No enabled strategies found -- skipping environment validation")
        return
    }

    const policy = validatePolicy(APP_NAME, firstEnabled.policy)
    const { workerUrl, accessKey, credentials } = resolveMT5Credentials(policy)
    const mt5Client = new MT5Client({ workerUrl, accessKey })

    try {
        // Check that the Python worker is reachable
        const health = await mt5Client.getHealth()
        logger.info("MT5 worker reachable", { health })

        // Connect to MT5 via the worker and verify account
        const accountInfo = await mt5Client.connect(credentials)
        logger.info("MT5 environment validated", {
            login: accountInfo.login,
            server: accountInfo.server,
            balance: accountInfo.balance,
            equity: accountInfo.equity,
            leverage: accountInfo.leverage,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("MT5 environment validation failed", { error: message })
        await backend.createAlert({
            app: APP_NAME,
            severity: "critical",
            message: `MT5 environment validation failed at startup: ${message}`,
        })
        throw new Error(`MT5 environment validation failed: ${message}`)
    }
}

// ---------------------------------------------------------------------------
// Kill switch checks
// ---------------------------------------------------------------------------

async function checkKillSwitch(context: string): Promise<boolean> {
    try {
        const state: KillSwitchState = await backend.getSystemState()

        if (state.globalKillSwitch) {
            logger.warn("Global kill switch is active", { context })
            return true
        }

        if (state.appKillSwitches[toKillSwitchKey(APP_NAME)]) {
            logger.warn("App kill switch is active", { context, app: APP_NAME })
            return true
        }

        return false
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to check kill switch -- proceeding with caution", {
            context,
            error: message,
        })
        return false
    }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function startHeartbeat(): void {
    heartbeatTimer = setInterval(async () => {
        try {
            await backend.reportHeartbeat(APP_NAME, healthState.ready ? "healthy" : "unhealthy", {
                strategyCount: healthState.strategyCount,
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

// ---------------------------------------------------------------------------
// Account snapshot persistence
// ---------------------------------------------------------------------------

async function persistAccountSnapshot(accountState: AccountState): Promise<void> {
    try {
        await backend.snapshotAccountState(APP_NAME, "mt5", accountState)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to persist account snapshot", { error: message })
    }
}

// ---------------------------------------------------------------------------
// Emergency flatten -- deterministic, not agent-controlled.
// Close all positions if unrealized loss exceeds the threshold.
// ---------------------------------------------------------------------------

async function checkEmergencyFlatten(
    venue: MT5VenueAdapter,
    policy: Record<string, unknown>,
    strategyId: string
): Promise<boolean> {
    const parsedPolicy = mt5PolicySchema.parse(policy)
    const accountState = await venue.getAccountState()

    if (accountState.openPnl < 0 && Math.abs(accountState.openPnl) >= parsedPolicy.emergencyFlattenThreshold) {
        logger.error("Emergency flatten triggered", {
            strategyId,
            openPnl: accountState.openPnl,
            threshold: parsedPolicy.emergencyFlattenThreshold,
        })

        await backend.createAlert({
            strategyId,
            app: APP_NAME,
            severity: "critical",
            message: `Emergency flatten triggered: unrealized loss ${Math.abs(accountState.openPnl).toFixed(2)} exceeds threshold ${parsedPolicy.emergencyFlattenThreshold}`,
        })

        const result = await venue.closeAllPositions()
        logger.info("Emergency flatten completed", {
            closed: result.closed,
            results: result.results.map((r) => ({
                orderId: r.orderId,
                status: r.status,
            })),
        })

        return true
    }

    return false
}

// ---------------------------------------------------------------------------
// End-of-day flatten -- close all positions before market close cutoff.
// This is deterministic and not controlled by the agent.
// ---------------------------------------------------------------------------

async function checkEndOfDayFlatten(
    venue: MT5VenueAdapter,
    policy: Record<string, unknown>,
    strategyId: string
): Promise<boolean> {
    const parsedPolicy = mt5PolicySchema.parse(policy)
    const { end, timezone } = parsedPolicy.tradingHours

    const now = getCurrentTimeInTimezone(timezone)
    const [endHour, endMinute] = end.split(":").map(Number) as [number, number]

    const currentMinutes = now.hours * 60 + now.minutes
    const endMinutes = endHour * 60 + endMinute

    // Flatten 15 minutes before end of trading hours
    const flattenMinutes = endMinutes - 15
    const shouldFlatten = currentMinutes >= flattenMinutes && currentMinutes < endMinutes

    if (!shouldFlatten) {
        return false
    }

    const positions = await venue.getPositions()
    if (positions.length === 0) {
        return false
    }

    logger.warn("End-of-day flatten triggered", {
        strategyId,
        currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
        endTime: end,
        openPositions: positions.length,
    })

    await backend.createAlert({
        strategyId,
        app: APP_NAME,
        severity: "warning",
        message: `End-of-day flatten: closing ${positions.length} position(s) before ${end} ${timezone}`,
    })

    const result = await venue.closeAllPositions()
    logger.info("End-of-day flatten completed", { closed: result.closed })

    return true
}

// ---------------------------------------------------------------------------
// Strategy execution
// ---------------------------------------------------------------------------

async function runStrategy(
    strategy: StoredStrategy,
    policy: Record<string, unknown>
): Promise<void> {
    if (await checkKillSwitch(`pre-run:${strategy._id}`)) {
        logger.warn("Run skipped due to active kill switch", { strategyId: strategy._id })
        await backend.createAlert({
            strategyId: strategy._id,
            app: APP_NAME,
            severity: "warning",
            message: "Strategy run skipped: kill switch active",
        })
        return
    }

    const { workerUrl, accessKey, credentials } = resolveMT5Credentials(policy)
    const mt5Client = new MT5Client({ workerUrl, accessKey })
    const venue = new MT5VenueAdapter(mt5Client, credentials)

    // Emergency flatten check before starting the agent
    const flattened = await checkEmergencyFlatten(venue, policy, strategy._id)
    if (flattened) {
        logger.warn("Emergency flatten executed -- skipping agent run", { strategyId: strategy._id })
        return
    }

    // End-of-day flatten check
    const eodFlattened = await checkEndOfDayFlatten(venue, policy, strategy._id)
    if (eodFlattened) {
        logger.warn("End-of-day flatten executed -- skipping agent run", { strategyId: strategy._id })
        return
    }

    const runId = await backend.createRun(strategy._id, APP_NAME)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
    })

    const orderPersistence = createConvexOrderPersistenceAdapter({
        url: runtimeConfig.convexUrl,
    })

    const killSwitchGuardedVenue = createKillSwitchGuardedVenue(venue, strategy._id)

    const pipeline = new ExecutionPipeline({
        venue: killSwitchGuardedVenue,
        venueName: "mt5",
        policy,
        riskValidators: mt5RiskValidators,
        logger: runLogger,
        tradeEventLogger: backend,
        orderPersistence,
        runId,
        strategyId: strategy._id,
    })

    const valiqClient = new ValiqClient({
        apiUrl: resolvedSecrets.VALIQ_API_URL!,
        authToken: resolvedSecrets.VALIQ_AUTH_TOKEN!,
        logger: runLogger,
    })
    const research = new ValiqResearchAdapter(valiqClient, runLogger)
    const data = new ValiqDataAdapter(valiqClient)

    const tools = new ToolRegistry()
    tools.register(createValiqResearchTool(research))
    tools.register(createValiqDataTool(data))
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
                app: APP_NAME,
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
                cleanup: [() => research.clearCurrentChat()],
            }
        )

        // Post-run: sync positions and account state to Convex
        const syncedPositions = await venue.getPositions()
        await backend.syncPositions(strategy._id, APP_NAME, syncedPositions)

        const finalAccountState = await venue.getAccountState()
        await persistAccountSnapshot(finalAccountState)

        // Post-run: check emergency flatten again (agent may have left a losing position)
        await checkEmergencyFlatten(venue, policy, strategy._id)

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
            await persistAccountSnapshot(failureAccountState)
        } catch {
            // Swallow -- if we can't reach the venue, nothing to snapshot
        }

        throw error
    } finally {
        pipeline.stopAllTracking()
    }
}

// ---------------------------------------------------------------------------
// Kill switch guard for venue adapter
// ---------------------------------------------------------------------------

function createKillSwitchGuardedVenue(
    venue: MT5VenueAdapter,
    strategyId: string
): MT5VenueAdapter {
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
    })
}

// ---------------------------------------------------------------------------
// Health server
// ---------------------------------------------------------------------------

function startHealthServer(port: number, scheduler: Scheduler): void {
    Bun.serve({
        port,
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

function loadRuntimeConfig(): RuntimeConfig {
    return {
        convexUrl: requireEnv("CONVEX_URL"),
        healthPort: Number(Bun.env.HEALTH_PORT ?? 3103),
    }
}

function requireEnv(name: string): string {
    const value = Bun.env[name]
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

// ---------------------------------------------------------------------------
// Timezone helpers (shared with risk-rules but kept here for flatten logic)
// ---------------------------------------------------------------------------

function getCurrentTimeInTimezone(timezone: string): { hours: number; minutes: number } {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        })
        const parts = formatter.formatToParts(new Date())
        const hourPart = parts.find((p) => p.type === "hour")
        const minutePart = parts.find((p) => p.type === "minute")

        return {
            hours: Number(hourPart?.value ?? 0),
            minutes: Number(minutePart?.value ?? 0),
        }
    } catch {
        const now = new Date()
        return { hours: now.getUTCHours(), minutes: now.getUTCMinutes() }
    }
}

function padTime(n: number): string {
    return String(n).padStart(2, "0")
}

await main()
