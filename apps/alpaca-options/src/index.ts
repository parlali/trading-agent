import { ToolRegistry, createCancelOrderTool, createGetAccountTool, createGetOrderStatusTool, createGetPositionsTool, createModifyOrderTool, createProposeAdjustmentTool, createProposeCloseTool, createProposeOrderTool, createWaitForOrderUpdateTool, createWebFetchTool, createWebSearchTool, executeAgentRun } from "@valiq-trading/agent"
import { createConvexOrderPersistenceAdapter, createTradingBackendClient, toKillSwitchKey, type KillSwitchState, type StoredStrategy } from "@valiq-trading/convex"
import { ExecutionPipeline, Scheduler, createLogger, validatePolicy, type AccountState } from "@valiq-trading/core"
import { createValiqDataTool, createValiqResearchTool, ValiqClient, ValiqDataAdapter, ValiqResearchAdapter } from "@valiq-trading/valiq"
import { AlpacaClient, type AlpacaCredentials } from "./alpaca-client"
import { alpacaRiskValidators } from "./risk-rules"
import { AlpacaOptionsVenueAdapter } from "./venue-adapter"
import { DuckDuckGoSearchProvider } from "./web-search"

const APP_NAME = "alpaca-options" as const
const HEARTBEAT_INTERVAL_MS = 30_000 // 30 seconds
const PAPER_URL_PATTERN = /paper/i

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
    environment?: "paper" | "live"
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

// Cache for secrets resolved from Convex so we don't fetch on every run
let resolvedSecrets: Record<string, string | null> = {}

async function main(): Promise<void> {
    // Resolve all secrets from Convex env vars at startup
    await resolveAllSecrets()

    // Validate Alpaca connectivity and detect paper vs live environment
    await validateEnvironment()

    const scheduler = new Scheduler({
        logger,
    })

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

    // Report initial healthy heartbeat
    await backend.reportHeartbeat(APP_NAME, "healthy", {
        strategyCount: activeStrategies.length,
        environment: healthState.environment,
        startedAt: healthState.startedAt,
    })

    logger.info("Alpaca options app started", {
        strategies: scheduler.getRegisteredStrategies(),
        healthPort: runtimeConfig.healthPort,
        environment: healthState.environment,
    })
}

// ---------------------------------------------------------------------------
// Secret resolution from Convex env vars
// ---------------------------------------------------------------------------

async function resolveAllSecrets(): Promise<void> {
    logger.info("Resolving secrets from Convex environment variables")

    // Request all possible secret keys we might need
    // This includes both broker-specific and generic fallback keys
    const secretKeys = [
        "ALPACA_API_KEY",
        "ALPACA_SECRET_KEY",
        "ALPACA_BASE_URL",
        "ALPACA_PRIMARY_API_KEY",
        "ALPACA_PRIMARY_SECRET_KEY",
        "ALPACA_PRIMARY_BASE_URL",
        "OPENROUTER_API_KEY",
        "OPENROUTER_MODEL",
        "VALIQ_API_URL",
        "VALIQ_AUTH_TOKEN",
    ]

    resolvedSecrets = await backend.resolveSecrets(secretKeys)

    // Validate that critical non-broker secrets are present
    const requiredSecrets = ["OPENROUTER_API_KEY", "VALIQ_API_URL", "VALIQ_AUTH_TOKEN"]
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

function resolveAlpacaCredentials(policy: Record<string, unknown>): AlpacaCredentials {
    const brokerRef = String(policy.broker ?? "").trim()
    const accountId = String(policy.accountId ?? "").trim()

    if (!brokerRef) {
        throw new Error("Alpaca policy broker reference is required")
    }

    if (!accountId) {
        throw new Error("Alpaca policy accountId is required")
    }

    const prefix = brokerRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

    return {
        apiKey: requireResolvedSecret(`ALPACA_${prefix}_API_KEY`, "ALPACA_API_KEY"),
        secretKey: requireResolvedSecret(`ALPACA_${prefix}_SECRET_KEY`, "ALPACA_SECRET_KEY"),
        accountId,
        baseUrl: resolvedSecrets[`ALPACA_${prefix}_BASE_URL`] ?? resolvedSecrets.ALPACA_BASE_URL ?? undefined,
    }
}

// ---------------------------------------------------------------------------
// Environment validation (paper vs live)
// ---------------------------------------------------------------------------

async function validateEnvironment(): Promise<void> {
    logger.info("Validating Alpaca environment connectivity")

    // Load strategies to get a broker config for validation
    const strategies = await backend.getStrategyConfigs(APP_NAME)
    const firstEnabled = strategies.find((strategy) => strategy.enabled)

    if (!firstEnabled) {
        logger.warn("No enabled strategies found -- skipping environment validation")
        return
    }

    const policy = validatePolicy(APP_NAME, firstEnabled.policy)
    const credentials = resolveAlpacaCredentials(policy)
    const alpacaClient = new AlpacaClient(credentials)
    const baseUrl = credentials.baseUrl ?? "https://paper-api.alpaca.markets"

    // Detect paper vs live from the base URL
    const isPaper = PAPER_URL_PATTERN.test(baseUrl)
    healthState.environment = isPaper ? "paper" : "live"

    try {
        const account = await alpacaClient.getAccount()
        logger.info("Alpaca environment validated", {
            environment: healthState.environment,
            baseUrl,
            accountId: account.id,
            equity: account.equity,
            buyingPower: account.buying_power,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Alpaca environment validation failed", {
            environment: healthState.environment,
            baseUrl,
            error: message,
        })
        await backend.createAlert({
            app: APP_NAME,
            severity: "critical",
            message: `Alpaca auth validation failed at startup (${healthState.environment}): ${message}`,
        })
        throw new Error(`Alpaca environment validation failed: ${message}`)
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
        // If we can't reach Convex to check the kill switch, log a warning but don't block
        // This prevents Convex outages from halting all operations
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
                environment: healthState.environment,
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
        await backend.snapshotAccountState(APP_NAME, "alpaca", accountState)
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
    // Kill switch check before run start
    if (await checkKillSwitch(`pre-run:${strategy._id}`)) {
        logger.warn("Run skipped due to active kill switch", { strategyId: strategy._id })
        await backend.createAlert({
            strategyId: strategy._id,
            app: APP_NAME,
            severity: "warning",
            message: `Strategy run skipped: kill switch active`,
        })
        return
    }

    const runId = await backend.createRun(strategy._id, APP_NAME)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
    })

    const credentials = resolveAlpacaCredentials(policy)
    const alpacaClient = new AlpacaClient(credentials)
    const venue = new AlpacaOptionsVenueAdapter(alpacaClient)
    const orderPersistence = createConvexOrderPersistenceAdapter({
        url: runtimeConfig.convexUrl,
    })

    // Wrap the execution pipeline with kill switch checks before order submission
    const killSwitchGuardedVenue = createKillSwitchGuardedVenue(venue, strategy._id)

    const pipeline = new ExecutionPipeline({
        venue: killSwitchGuardedVenue,
        venueName: "alpaca",
        policy,
        riskValidators: alpacaRiskValidators,
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

        const syncedPositions = await venue.getPositions()
        await backend.syncPositions(strategy._id, APP_NAME, syncedPositions)

        // Persist account snapshot after every run (success or failure path below)
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

        // Still try to snapshot account state on failure
        try {
            const failureAccountState = await venue.getAccountState()
            await persistAccountSnapshot(failureAccountState)
        } catch {
            // Swallow -- if we can't even reach the venue, nothing to snapshot
        }

        throw error
    } finally {
        pipeline.stopAllTracking()
    }
}

// ---------------------------------------------------------------------------
// Kill switch guard for venue adapter (checks before order submission)
// ---------------------------------------------------------------------------

function createKillSwitchGuardedVenue(
    venue: AlpacaOptionsVenueAdapter,
    strategyId: string
): AlpacaOptionsVenueAdapter {
    // Create a proxy that intercepts submitOrder to check kill switch
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
                environment: healthState.environment,
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

        // Report unhealthy heartbeat before shutdown
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
        healthPort: Number(Bun.env.HEALTH_PORT ?? 3101),
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
