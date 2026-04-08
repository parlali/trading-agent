import {
    ToolPool,
    ToolRegistry,
    createAlpacaGetOptionsChainTool,
    createAlpacaGetQuoteTool,
    createBinanceGetMarketPriceTool,
    createBinanceGetOrderBookTool,
    createBinanceProposeAdjustmentTool,
    createBinanceProposeCloseTool,
    createBinanceProposeOrderTool,
    createCancelOrderTool,
    createGetAccountTool,
    createGetOrderStatusTool,
    createGetPositionsTool,
    createMT5ProposeCloseTool,
    createMT5GetSymbolInfoTool,
    createModifyOrderTool,
    createProposeAdjustmentTool,
    createPolymarketGetMarketPriceTool,
    createPolymarketGetOrderBookTool,
    createMT5ProposeAdjustmentTool,
    createMT5ProposeOrderTool,
    createPolymarketSearchMarketsTool,
    createPolymarketProposeCloseTool,
    createPolymarketProposeAdjustmentTool,
    createPolymarketProposeOrderTool,
    createProposeCloseTool,
    createProposeOrderTool,
    createWaitForOrderUpdateTool,
    createWebFetchTool,
    createWebSearchTool,
    executeAgentRun,
    withCallBudget,
    type ToolCategory,
    type ToolDefinition,
} from "@valiq-trading/agent"
import { createConvexOrderPersistenceAdapter } from "@valiq-trading/convex"
import type { StoredStrategy } from "@valiq-trading/convex"
import {
    ExecutionPipeline,
    VENUE_APPS,
    isTerminalOrderStatus,
    createInstrumentConflictValidator,
    createKillSwitchGuardedVenue as createRuntimeKillSwitchGuardedVenue,
    binancePolicySchema,
    filterPositionsByOwnership,
    getNextCronFireMs,
    mt5PolicySchema,
    parseSummaryMetadata,
    stripMetadataBlock,
    validatePolicy,
    withTimeout,
    type PendingOrderContext,
    type Logger,
    type Scheduler,
    type OrderSnapshot,
    type VenueAdapter,
} from "@valiq-trading/core"
import { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import { BinanceVenueAdapter } from "@valiq-trading/binance"
import { MT5VenueAdapter } from "@valiq-trading/mt5"
import { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { RunTrigger } from "@valiq-trading/convex"
import type { VenueApp, VenuePlugin } from "./types"

export const pendingManualTriggers = new Set<string>()
import {
    backend,
    convexUrl,
    backendServiceToken,
    logger,
    plugins,
    resolvedSecrets,
    searchProvider,
    syncStrategies,
    killSwitchCheckers,
    healthState,
} from "./state"
import { reconcileProviderPortfolio, recordProviderSyncFailure } from "./provider-sync"

const PRE_RUN_HOOK_TIMEOUT_MS = 90_000
const POST_RUN_HOOK_TIMEOUT_MS = 90_000
const STRATEGY_RUN_TIMEOUT_MS = 12 * 60 * 1000
const EXTRA_TOOL_CATEGORIES: Record<string, ToolCategory> = {
    query_valiq_research: "research",
    query_valiq_data: "research",
    get_breaking_news: "research",
}

export function updateHealth(
    status: "completed" | "failed",
    summary?: string,
    error?: string
): void {
    healthState.lastRunAt = Date.now()
    healthState.lastRunStatus = status
    healthState.lastRunSummary = summary
    healthState.lastRunError = error
}

async function checkKillSwitch(app: VenueApp, context: string): Promise<boolean> {
    return await killSwitchCheckers[app](context)
}

function createKillSwitchGuardedVenue(
    venue: VenueAdapter,
    app: VenueApp,
    strategyId: string
): VenueAdapter {
    return createRuntimeKillSwitchGuardedVenue(
        venue,
        strategyId,
        killSwitchCheckers[app]
    )
}

function mergeRuntimeContextLines(
    existing: string[] | undefined,
    additional: string[]
): string[] | undefined {
    if (additional.length === 0) {
        return existing
    }

    return [...(existing ?? []), ...additional]
}

function buildPendingOrderContext(snapshot: OrderSnapshot): PendingOrderContext {
    return {
        orderId: snapshot.orderId,
        instrument: snapshot.instrument,
        action: snapshot.action,
        status: snapshot.status,
        quantity: snapshot.quantity,
        filledQuantity: snapshot.filledQuantity,
        remainingQuantity: snapshot.remainingQuantity,
        submittedAt: snapshot.submittedAt,
        updatedAt: snapshot.updatedAt,
        limitPrice: snapshot.intent.limitPrice,
        avgFillPrice: snapshot.avgFillPrice,
        recommendedAction: getPendingOrderRecommendedAction(snapshot),
    }
}

function getPendingOrderRecommendedAction(snapshot: OrderSnapshot): string {
    if (snapshot.status === "partially_filled") {
        return "Review the remaining quantity immediately. Decide whether to keep working the remainder, improve the price, or cancel the rest."
    }

    if (snapshot.polling.timedOutAt) {
        return "Refresh this order first. The prior run handed it off after its wait window expired while the venue order was still live."
    }

    return "Refresh the working order, then either keep waiting, improve the limit price, or cancel if the thesis or session conditions changed."
}

function resolveExtraToolCategory(
    tool: ToolDefinition,
    runLogger: Logger,
    app: VenueApp
): ToolCategory {
    const category = EXTRA_TOOL_CATEGORIES[tool.name]
    if (category) {
        return category
    }

    runLogger.warn("Unknown extra tool category, defaulting to research", {
        app,
        tool: tool.name,
    })

    return "research"
}

function logVenueToolMismatch(
    runLogger: Logger,
    app: VenueApp,
    toolName: string,
    expectedAdapter: string,
    venue: VenueAdapter
): void {
    runLogger.warn("Tool registration skipped due to incompatible venue adapter", {
        app,
        tool: toolName,
        expectedAdapter,
        receivedAdapter: venue.constructor.name,
    })
}

function buildToolPool(config: {
    app: VenueApp
    venue: VenueAdapter
    pipeline: ExecutionPipeline
    policy: Record<string, unknown>
    extraTools: ToolDefinition[]
    isCallback: boolean
    runLogger: Logger
}): ToolPool {
    const {
        app,
        venue,
        pipeline,
        policy,
        extraTools,
        isCallback,
        runLogger,
    } = config

    const toolPool = new ToolPool({
        logger: runLogger,
    })

    for (const tool of extraTools) {
        toolPool.registerTool({
            tool,
            category: resolveExtraToolCategory(tool, runLogger, app),
            compatibleVenues: [app],
        })
    }

    toolPool.registerFactory({
        name: "get_positions",
        category: "account",
        compatibleVenues: VENUE_APPS,
        create: () => createGetPositionsTool(pipeline),
    })
    toolPool.registerFactory({
        name: "get_account",
        category: "account",
        compatibleVenues: VENUE_APPS,
        create: () => createGetAccountTool(pipeline),
    })
    toolPool.registerFactory({
        name: "get_order_status",
        category: "execution",
        compatibleVenues: VENUE_APPS,
        create: () => createGetOrderStatusTool(pipeline),
    })
    toolPool.registerFactory({
        name: "cancel_order",
        category: "execution",
        compatibleVenues: VENUE_APPS,
        create: () => createCancelOrderTool(pipeline),
    })
    toolPool.registerFactory({
        name: "wait_for_order_update",
        category: "execution",
        compatibleVenues: VENUE_APPS,
        create: () => createWaitForOrderUpdateTool(pipeline),
    })
    toolPool.registerFactory({
        name: "modify_order",
        category: "execution",
        compatibleVenues: ["alpaca-options"],
        create: () => createModifyOrderTool(pipeline, { mode: "alpaca-options" }),
    })
    toolPool.registerFactory({
        name: "modify_order",
        category: "execution",
        compatibleVenues: ["mt5", "binance-futures", "polymarket"],
        create: () => createModifyOrderTool(pipeline),
    })
    toolPool.registerFactory({
        name: "get_symbol_info",
        category: "market-data",
        compatibleVenues: ["mt5"],
        create: () => {
            if (!(venue instanceof MT5VenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_symbol_info", "MT5VenueAdapter", venue)
                return null
            }

            return createMT5GetSymbolInfoTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "propose_order",
        category: "execution",
        compatibleVenues: ["mt5"],
        create: () => {
            if (!(venue instanceof MT5VenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_order", "MT5VenueAdapter", venue)
                return null
            }

            return createMT5ProposeOrderTool(pipeline, venue, mt5PolicySchema.parse(policy))
        },
    })
    toolPool.registerFactory({
        name: "propose_adjustment",
        category: "execution",
        compatibleVenues: ["mt5"],
        create: () => {
            if (!(venue instanceof MT5VenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_adjustment", "MT5VenueAdapter", venue)
                return null
            }

            return createMT5ProposeAdjustmentTool(pipeline, venue, mt5PolicySchema.parse(policy))
        },
    })
    toolPool.registerFactory({
        name: "propose_close",
        category: "execution",
        compatibleVenues: ["mt5"],
        create: () => {
            if (!(venue instanceof MT5VenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_close", "MT5VenueAdapter", venue)
                return null
            }

            return createMT5ProposeCloseTool(pipeline, venue)
        },
    })
    toolPool.registerFactory({
        name: "get_options_chain",
        category: "market-data",
        compatibleVenues: ["alpaca-options"],
        create: () => {
            if (!(venue instanceof AlpacaOptionsVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_options_chain", "AlpacaOptionsVenueAdapter", venue)
                return null
            }

            return createAlpacaGetOptionsChainTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "get_quote",
        category: "market-data",
        compatibleVenues: ["alpaca-options"],
        create: () => {
            if (!(venue instanceof AlpacaOptionsVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_quote", "AlpacaOptionsVenueAdapter", venue)
                return null
            }

            return createAlpacaGetQuoteTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "propose_order",
        category: "execution",
        compatibleVenues: ["alpaca-options"],
        create: () => {
            if (!(venue instanceof AlpacaOptionsVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_order", "AlpacaOptionsVenueAdapter", venue)
                return null
            }

            return createProposeOrderTool(pipeline, {
                mode: "alpaca-options",
            })
        },
    })
    toolPool.registerFactory({
        name: "propose_adjustment",
        category: "execution",
        compatibleVenues: ["alpaca-options"],
        create: () => createProposeAdjustmentTool(pipeline),
    })
    toolPool.registerFactory({
        name: "propose_close",
        category: "execution",
        compatibleVenues: ["alpaca-options"],
        create: () => createProposeCloseTool(pipeline),
    })
    toolPool.registerFactory({
        name: "get_market_price",
        category: "market-data",
        compatibleVenues: ["binance-futures"],
        create: () => {
            if (!(venue instanceof BinanceVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_market_price", "BinanceVenueAdapter", venue)
                return null
            }

            return createBinanceGetMarketPriceTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "get_order_book",
        category: "market-data",
        compatibleVenues: ["binance-futures"],
        create: () => {
            if (!(venue instanceof BinanceVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_order_book", "BinanceVenueAdapter", venue)
                return null
            }

            return createBinanceGetOrderBookTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "propose_order",
        category: "execution",
        compatibleVenues: ["binance-futures"],
        create: () => {
            if (!(venue instanceof BinanceVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_order", "BinanceVenueAdapter", venue)
                return null
            }

            return createBinanceProposeOrderTool(
                pipeline,
                venue,
                binancePolicySchema.parse(policy)
            )
        },
    })
    toolPool.registerFactory({
        name: "propose_adjustment",
        category: "execution",
        compatibleVenues: ["binance-futures"],
        create: () => {
            if (!(venue instanceof BinanceVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_adjustment", "BinanceVenueAdapter", venue)
                return null
            }

            const binancePolicy = binancePolicySchema.parse(policy)
            return createBinanceProposeAdjustmentTool(pipeline, venue, {
                dryRun: binancePolicy.dryRun,
            })
        },
    })
    toolPool.registerFactory({
        name: "propose_close",
        category: "execution",
        compatibleVenues: ["binance-futures"],
        create: () => {
            if (!(venue instanceof BinanceVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_close", "BinanceVenueAdapter", venue)
                return null
            }

            return createBinanceProposeCloseTool(pipeline, venue)
        },
    })
    toolPool.registerFactory({
        name: "get_market_price",
        category: "market-data",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_market_price", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketGetMarketPriceTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "get_order_book",
        category: "market-data",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_order_book", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketGetOrderBookTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "search_markets",
        category: "market-data",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "search_markets", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketSearchMarketsTool(venue)
        },
    })
    toolPool.registerFactory({
        name: "propose_order",
        category: "execution",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_order", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketProposeOrderTool(pipeline, venue)
        },
    })
    toolPool.registerFactory({
        name: "propose_adjustment",
        category: "execution",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_adjustment", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketProposeAdjustmentTool(pipeline, venue)
        },
    })
    toolPool.registerFactory({
        name: "propose_close",
        category: "execution",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "propose_close", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketProposeCloseTool(pipeline, venue)
        },
    })
    toolPool.registerFactory({
        name: "web_search",
        category: "web",
        compatibleVenues: ["polymarket"],
        create: () => withCallBudget(
            createWebSearchTool(searchProvider),
            isCallback ? 2 : 5
        ),
    })
    toolPool.registerFactory({
        name: "web_fetch",
        category: "web",
        compatibleVenues: ["polymarket"],
        create: () => withCallBudget(
            createWebFetchTool(),
            isCallback ? 1 : 3
        ),
    })

    return toolPool
}

async function reconcilePendingOrdersForRun(
    pipeline: ExecutionPipeline,
    strategyId: string,
    orderPersistence: ReturnType<typeof createConvexOrderPersistenceAdapter>,
    runLogger: Logger
): Promise<{ pendingOrders: PendingOrderContext[]; runtimeContextLines: string[] }> {
    const persistedActiveOrders = await orderPersistence.listActiveOrders(strategyId)
    if (persistedActiveOrders.length === 0) {
        return {
            pendingOrders: [],
            runtimeContextLines: [],
        }
    }

    const pendingOrders: PendingOrderContext[] = []
    const runtimeContextLines: string[] = []

    for (const persistedOrder of persistedActiveOrders) {
        try {
            await pipeline.getOrderStatus(persistedOrder.orderId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            runLogger.warn("Failed to refresh persisted active order before run", {
                orderId: persistedOrder.orderId,
                error: message,
            })
            runtimeContextLines.push(
                `Active order refresh failed at run start for ${persistedOrder.orderId}. Do not trust the stored snapshot without a successful venue refresh.`
            )
            continue
        }

        const refreshedSnapshot = await pipeline.getOrderSnapshot(persistedOrder.orderId)
        if (!refreshedSnapshot || isTerminalOrderStatus(refreshedSnapshot.status)) {
            continue
        }

        pendingOrders.push(buildPendingOrderContext(refreshedSnapshot))
    }

    if (pendingOrders.length > 0) {
        await pipeline.resumeOpenOrders(() => ({ decision: "wait" }))
    }

    return {
        pendingOrders,
        runtimeContextLines,
    }
}

export async function registerStrategyWithScheduler(
    scheduler: Scheduler,
    app: VenueApp,
    strategy: StoredStrategy
): Promise<void> {
    const plugin = plugins[app]
    const policy = validatePolicy(app, strategy.policy)
    const additionalSecretKeys = plugin.resolveAdditionalSecretKeys?.(policy) ?? []
    const additionalSecrets =
        additionalSecretKeys.length > 0
            ? await backend.resolveSecrets(additionalSecretKeys)
            : {}
    const strategySecrets = {
        ...resolvedSecrets,
        ...additionalSecrets,
    }

    syncStrategies[app] ??= []
    const alreadyTracked = syncStrategies[app].some(
        (e) => e.strategy._id === strategy._id
    )
    if (!alreadyTracked) {
        syncStrategies[app].push({
            strategy,
            policy,
            secrets: strategySecrets,
        })
    }

    scheduler.register({
        strategyId: strategy._id,
        scheduleType: "cron",
        cronExpression: strategy.schedule,
        handler: async () => {
            const isManual = pendingManualTriggers.delete(strategy._id)
            await runStrategy(app, plugin, strategy, policy, strategySecrets, scheduler, isManual ? "manual" : "cron")
        },
    })
}

export async function runStrategy(
    app: VenueApp,
    plugin: VenuePlugin,
    strategy: StoredStrategy,
    policy: Record<string, unknown>,
    strategySecrets: Record<string, string | null>,
    scheduler?: Scheduler,
    trigger: RunTrigger = "cron"
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

    const venue = plugin.createVenueAdapter(policy, strategySecrets)
    let runtimeContextLines: string[] | undefined

    if (plugin.preRunHooks) {
        const hookResult = await withTimeout(
            async () => await plugin.preRunHooks!({
                venue,
                policy,
                strategyId: strategy._id,
                logger,
                createAlert: (alert) => backend.createAlert(alert),
            }),
            PRE_RUN_HOOK_TIMEOUT_MS,
            `pre-run hooks for strategy ${strategy._id}`
        )
        if (hookResult.skip) {
            logger.warn("Pre-run hook skipped strategy", {
                strategyId: strategy._id,
                app,
                reason: hookResult.reason,
            })
            return
        }

        runtimeContextLines = hookResult.runtimeContextLines
    }

    const runId = await backend.createRun(strategy._id, app, trigger)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
        app,
    })

    const [ownedInstrumentsList, allOwnedInstruments] = await Promise.all([
        backend.getStrategyOwnedInstruments(strategy._id),
        backend.getAllOwnedInstrumentsByApp(app),
    ])

    const ownedInstruments = new Set(ownedInstrumentsList)
    const conflictMap = new Map<string, string>()
    for (const entry of allOwnedInstruments) {
        if (entry.strategyId !== strategy._id) {
            conflictMap.set(entry.instrument, entry.strategyId)
        }
    }

    const pluginValidators = plugin.getRiskValidators()
    const riskValidators = conflictMap.size > 0
        ? [...pluginValidators, createInstrumentConflictValidator(conflictMap)]
        : pluginValidators

    const orderPersistence = createConvexOrderPersistenceAdapter({
        url: convexUrl,
        machineAuth: {
            serviceToken: backendServiceToken,
        },
    })
    const guardedVenue = createKillSwitchGuardedVenue(venue, app, strategy._id)

    const pipeline = new ExecutionPipeline({
        venue: guardedVenue,
        venueName: plugin.venueName,
        policy,
        riskValidators,
        logger: runLogger,
        tradeEventLogger: backend,
        orderPersistence,
        runId,
        strategyId: strategy._id,
        ownedInstruments,
    })

    const extraTools = plugin.getExtraTools({
        secrets: strategySecrets,
        runLogger,
    })
    const isCallback = trigger === "callback"
    const budgetedExtraTools = extraTools.map((tool) =>
        isCallback ? withCallBudget(tool, 2) : tool
    )

    const toolPool = buildToolPool({
        app,
        venue,
        pipeline,
        policy,
        extraTools: budgetedExtraTools,
        isCallback,
        runLogger,
    })
    const tools = new ToolRegistry()
    for (const tool of toolPool.forVenue(app)) {
        tools.register(tool)
    }

    try {
        await withTimeout(async () => {
            if (!resolvedSecrets.OPENROUTER_API_KEY) {
                throw new Error("Cannot run strategy: OPENROUTER_API_KEY is not set in Convex environment variables")
            }

            const isDryRun = Boolean(policy.dryRun)
            const { pendingOrders, runtimeContextLines: pendingOrderRuntimeContext } = await reconcilePendingOrdersForRun(
                pipeline,
                strategy._id,
                orderPersistence,
                runLogger
            )
            runtimeContextLines = mergeRuntimeContextLines(runtimeContextLines, pendingOrderRuntimeContext)

            const [allPositions, accountState, previousRunSummary] = await Promise.all([
                isDryRun ? backend.getLatestPositions(strategy._id) : venue.getPositions(),
                venue.getAccountState(),
                backend.getLastCompletedRunSummary(strategy._id),
            ])
            const positions = isDryRun
                ? allPositions
                : filterPositionsByOwnership(allPositions, ownedInstruments)

            if (isDryRun) {
                pipeline.seedDryRunPositions(positions)
            }

            const result = await executeAgentRun(
                {
                    runId,
                    strategyId: strategy._id,
                    app,
                    timestamp: Date.now(),
                    trigger,
                    positions,
                    accountState,
                    policy,
                    context: strategy.context,
                    runtimeContextLines,
                    schedule: strategy.schedule,
                    pendingOrders,
                    previousRunSummary: previousRunSummary ?? undefined,
                },
                {
                    llm: {
                        apiKey: resolvedSecrets.OPENROUTER_API_KEY,
                        model: resolvedSecrets.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.6",
                    },
                    tools,
                    logger: runLogger,
                    agentLogger: backend,
                    killSwitchChecker: () => checkKillSwitch(app, `mid-run:${strategy._id}`),
                }
            )

            if (plugin.postRunHooks) {
                await withTimeout(
                    async () => await plugin.postRunHooks!({
                        venue,
                        policy,
                        strategyId: strategy._id,
                        logger: runLogger,
                        createAlert: (alert) => backend.createAlert(alert),
                    }),
                    POST_RUN_HOOK_TIMEOUT_MS,
                    `post-run hooks for strategy ${strategy._id}`
                )
            }

            if (isDryRun) {
                const syncedPositions = pipeline.getDryRunPositions()
                await backend.syncPositions(strategy._id, app, syncedPositions)
            } else {
                await reconcileProviderPortfolio({
                    app,
                    venueName: plugin.venueName,
                    source: "post_run_sync",
                    venue,
                })
            }

            const cleanSummary = result.summary
                ? stripMetadataBlock(result.summary)
                : result.summary

            if (result.error) {
                await Promise.all([
                    backend.updateRun(runId, "failed", cleanSummary, result.error),
                    backend.createAlert({
                        strategyId: strategy._id,
                        app,
                        severity: "warning",
                        message: `Agent run failed: ${result.error}`,
                    }),
                ])
                updateHealth("failed", cleanSummary, result.error)
                return
            }

            await backend.updateRun(runId, "completed", cleanSummary)
            updateHealth("completed", cleanSummary)

            if (scheduler && result.summary) {
                const metadata = parseSummaryMetadata(result.summary)
                if (metadata?.nextRunInMinutes) {
                    const delayMs = metadata.nextRunInMinutes * 60 * 1000
                    const nextCronMs = getNextCronFireMs(strategy.schedule)
                    if (nextCronMs && delayMs >= nextCronMs) {
                        logger.info("Oneshot not scheduled -- cron fires sooner", {
                            strategyId: strategy._id,
                            requestedMs: delayMs,
                            nextCronMs,
                        })
                    } else {
                        const callbackFiresAt = Date.now() + delayMs
                        scheduler.scheduleOneshot(strategy._id, delayMs, async () => {
                            await runStrategy(app, plugin, strategy, policy, strategySecrets, scheduler, "callback")
                        })
                        void backend.recordRunCallback(
                            runId,
                            metadata.nextRunInMinutes,
                            callbackFiresAt
                        )
                    }
                }
            }
        }, STRATEGY_RUN_TIMEOUT_MS, `strategy run ${strategy._id}`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await Promise.all([
            backend.updateRun(runId, "failed", undefined, message),
            backend.createAlert({
                strategyId: strategy._id,
                app,
                severity: "critical",
                message: `Strategy run crashed: ${message}`,
            }),
        ])
        updateHealth("failed", undefined, message)

        try {
            if (Boolean(policy.dryRun)) {
                await backend.syncPositions(strategy._id, app, pipeline.getDryRunPositions())
            } else {
                await reconcileProviderPortfolio({
                    app,
                    venueName: plugin.venueName,
                    source: "post_run_sync",
                    venue,
                })
            }
        } catch (syncError) {
            const syncMessage = syncError instanceof Error ? syncError.message : String(syncError)
            if (!Boolean(policy.dryRun)) {
                await recordProviderSyncFailure(app, syncMessage)
            }
        }

        throw error
    } finally {
        pipeline.stopAllTracking()
    }
}
