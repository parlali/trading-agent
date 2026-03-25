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
import { ExecutionPipeline, Scheduler, createLogger, validatePolicy, type AccountState } from "@valiq-trading/core"
import { PolymarketClient, type PolymarketCredentials } from "./polymarket-client"
import { polymarketRiskValidators } from "./risk-rules"
import { PolymarketVenueAdapter } from "./venue-adapter"
import { DuckDuckGoSearchProvider } from "./web-search"

const APP_NAME = "polymarket" as const
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

    logger.info("Polymarket app started", {
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
        "POLYMARKET_PRIVATE_KEY",
        "POLYMARKET_API_KEY",
        "POLYMARKET_API_SECRET",
        "POLYMARKET_API_PASSPHRASE",
        "POLYMARKET_HOST",
        "POLYMARKET_CHAIN_ID",
        "OPENROUTER_API_KEY",
        "OPENROUTER_MODEL",
    ]

    resolvedSecrets = await backend.resolveSecrets(secretKeys)

    const requiredSecrets = ["OPENROUTER_API_KEY"]
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

function requireResolvedSecret(primary: string, fallback?: string): string {
    const value = resolvedSecrets[primary] ?? (fallback ? resolvedSecrets[fallback] : undefined)
    if (!value) {
        const keys = fallback ? `${primary} (or fallback ${fallback})` : primary
        throw new Error(
            `Missing required secret: ${keys}. Set this in Convex environment variables.`
        )
    }
    return value
}

function resolvePolymarketCredentials(policy: Record<string, unknown>): PolymarketCredentials {
    const credentialsRef = String(policy.credentialsRef ?? "").trim()

    if (!credentialsRef) {
        throw new Error("Polymarket policy credentialsRef is required")
    }

    const prefix = credentialsRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

    return {
        privateKey: requireResolvedSecret(`POLYMARKET_${prefix}_PRIVATE_KEY`, "POLYMARKET_PRIVATE_KEY"),
        apiKey: requireResolvedSecret(`POLYMARKET_${prefix}_API_KEY`, "POLYMARKET_API_KEY"),
        apiSecret: requireResolvedSecret(`POLYMARKET_${prefix}_API_SECRET`, "POLYMARKET_API_SECRET"),
        apiPassphrase: requireResolvedSecret(`POLYMARKET_${prefix}_API_PASSPHRASE`, "POLYMARKET_API_PASSPHRASE"),
        host: resolvedSecrets[`POLYMARKET_${prefix}_HOST`] ?? resolvedSecrets.POLYMARKET_HOST ?? undefined,
        chainId: resolvedSecrets[`POLYMARKET_${prefix}_CHAIN_ID`]
            ? Number(resolvedSecrets[`POLYMARKET_${prefix}_CHAIN_ID`])
            : resolvedSecrets.POLYMARKET_CHAIN_ID
                ? Number(resolvedSecrets.POLYMARKET_CHAIN_ID)
                : undefined,
    }
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

async function validateEnvironment(): Promise<void> {
    logger.info("Validating Polymarket environment connectivity")

    const strategies = await backend.getStrategyConfigs(APP_NAME)
    const firstEnabled = strategies.find((strategy) => strategy.enabled)

    if (!firstEnabled) {
        logger.warn("No enabled strategies found -- skipping environment validation")
        return
    }

    const policy = validatePolicy(APP_NAME, firstEnabled.policy)

    // Request the additional credential-specific secret keys
    const credentialsRef = String(policy.credentialsRef ?? "").trim()
    const prefix = credentialsRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    const credentialKeys = [
        `POLYMARKET_${prefix}_PRIVATE_KEY`,
        `POLYMARKET_${prefix}_API_KEY`,
        `POLYMARKET_${prefix}_API_SECRET`,
        `POLYMARKET_${prefix}_API_PASSPHRASE`,
        `POLYMARKET_${prefix}_HOST`,
        `POLYMARKET_${prefix}_CHAIN_ID`,
    ]
    const additionalSecrets = await backend.resolveSecrets(credentialKeys)
    resolvedSecrets = { ...resolvedSecrets, ...additionalSecrets }

    const credentials = resolvePolymarketCredentials(policy)
    const client = new PolymarketClient(credentials)

    try {
        const balance = await client.getBalance()
        logger.info("Polymarket environment validated", {
            host: credentials.host ?? "https://clob.polymarket.com",
            address: client.getAddress(),
            balance,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Polymarket environment validation failed", {
            host: credentials.host ?? "https://clob.polymarket.com",
            error: message,
        })
        await backend.createAlert({
            app: APP_NAME,
            severity: "critical",
            message: `Polymarket auth validation failed at startup: ${message}`,
        })
        throw new Error(`Polymarket environment validation failed: ${message}`)
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
        await backend.snapshotAccountState(APP_NAME, "polymarket", accountState)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to persist account snapshot", { error: message })
    }
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

    const runId = await backend.createRun(strategy._id, APP_NAME)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
    })

    const credentials = resolvePolymarketCredentials(policy)
    const polyClient = new PolymarketClient(credentials)
    const venue = new PolymarketVenueAdapter(polyClient)
    const orderPersistence = createConvexOrderPersistenceAdapter({
        url: runtimeConfig.convexUrl,
    })

    const killSwitchGuardedVenue = createKillSwitchGuardedVenue(venue, strategy._id)

    const pipeline = new ExecutionPipeline({
        venue: killSwitchGuardedVenue,
        venueName: "polymarket",
        policy,
        riskValidators: polymarketRiskValidators,
        logger: runLogger,
        tradeEventLogger: backend,
        orderPersistence,
        runId,
        strategyId: strategy._id,
    })

    const tools = new ToolRegistry()
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
            }
        )

        const syncedPositions = await venue.getPositions()
        await backend.syncPositions(strategy._id, APP_NAME, syncedPositions)

        const finalAccountState = await venue.getAccountState()
        await persistAccountSnapshot(finalAccountState)

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
            // Swallow — if we can't reach the venue, nothing to snapshot
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
    venue: PolymarketVenueAdapter,
    strategyId: string
): PolymarketVenueAdapter {
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
        healthPort: Number(Bun.env.HEALTH_PORT ?? 3102),
    }
}

function requireEnv(name: string): string {
    const value = Bun.env[name]
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

await main()
