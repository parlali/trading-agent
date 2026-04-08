import {
    ToolRegistry,
    createBinanceProposeAdjustmentTool,
    createBinanceProposeCloseTool,
    createBinanceProposeOrderTool,
    createCancelOrderTool,
    createGetAccountTool,
    createGetOrderStatusTool,
    createGetPositionsTool,
    createMT5ProposeCloseTool,
    createModifyOrderTool,
    createMT5ProposeAdjustmentTool,
    createMT5ProposeOrderTool,
    createPolymarketProposeCloseTool,
    createPolymarketProposeAdjustmentTool,
    createPolymarketProposeOrderTool,
    createProposeAdjustmentTool,
    createProposeCloseTool,
    createProposeOrderTool,
    createWaitForOrderUpdateTool,
    createWebFetchTool,
    createWebSearchTool,
    executeAgentRun,
    withCallBudget,
} from "@valiq-trading/agent"
import { createConvexOrderPersistenceAdapter } from "@valiq-trading/convex"
import type { StoredStrategy } from "@valiq-trading/convex"
import {
    ExecutionPipeline,
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
    accountSnapshotPersisters,
    healthState,
} from "./state"

const PRE_RUN_HOOK_TIMEOUT_MS = 90_000
const POST_RUN_HOOK_TIMEOUT_MS = 90_000
const STRATEGY_RUN_TIMEOUT_MS = 12 * 60 * 1000

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

    const tools = new ToolRegistry()

    const extraTools = plugin.getExtraTools({
        secrets: strategySecrets,
        runLogger,
    })
    const isCallback = trigger === "callback"
    for (const tool of extraTools) {
        const budgeted = isCallback ? withCallBudget(tool, 2) : tool
        tools.register(budgeted)
    }

    tools.register(createGetPositionsTool(pipeline))
    tools.register(createGetAccountTool(pipeline))

    if (app === "mt5" && venue instanceof MT5VenueAdapter) {
        const mt5Policy = mt5PolicySchema.parse(policy)
        tools.register(createMT5ProposeOrderTool(pipeline, venue, mt5Policy))
        tools.register(createMT5ProposeAdjustmentTool(pipeline, venue, mt5Policy))
        tools.register(createMT5ProposeCloseTool(pipeline, venue))
    } else if (app === "alpaca-options") {
        tools.register(createProposeOrderTool(pipeline, { mode: "alpaca-options" }))
        tools.register(createProposeCloseTool(pipeline))
    } else if (app === "binance-futures" && venue instanceof BinanceVenueAdapter) {
        const binancePolicy = binancePolicySchema.parse(policy)
        tools.register(createBinanceProposeOrderTool(pipeline, venue, binancePolicy))
        tools.register(createBinanceProposeAdjustmentTool(pipeline, venue, { dryRun: binancePolicy.dryRun }))
        tools.register(createBinanceProposeCloseTool(pipeline, venue))
    } else if (app === "polymarket" && venue instanceof PolymarketVenueAdapter) {
        tools.register(createPolymarketProposeOrderTool(pipeline, venue))
        tools.register(createPolymarketProposeAdjustmentTool(pipeline, venue))
        tools.register(createPolymarketProposeCloseTool(pipeline, venue))
    } else {
        tools.register(createProposeOrderTool(pipeline))
        tools.register(createProposeAdjustmentTool(pipeline))
        tools.register(createProposeCloseTool(pipeline))
    }

    tools.register(createGetOrderStatusTool(pipeline))
    tools.register(createCancelOrderTool(pipeline))
    tools.register(createModifyOrderTool(
        pipeline,
        app === "alpaca-options" ? { mode: "alpaca-options" } : undefined
    ))
    tools.register(createWaitForOrderUpdateTool(pipeline))
    if (app === "polymarket") {
        const searchBudget = isCallback ? 2 : 5
        const fetchBudget = isCallback ? 1 : 3
        tools.register(withCallBudget(createWebSearchTool(searchProvider), searchBudget))
        tools.register(withCallBudget(createWebFetchTool(), fetchBudget))
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

            const [syncedPositions, finalAccountState] = await Promise.all([
                isDryRun
                    ? Promise.resolve(pipeline.getDryRunPositions())
                    : venue.getPositions().then((all) => filterPositionsByOwnership(all, ownedInstruments)),
                venue.getAccountState(),
            ])
            await Promise.all([
                backend.syncPositions(strategy._id, app, syncedPositions),
                accountSnapshotPersisters[app](finalAccountState),
            ])

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
            const failureAccountState = await venue.getAccountState()
            await accountSnapshotPersisters[app](failureAccountState)
        } catch {
            // Cannot reach venue for snapshot
        }

        throw error
    } finally {
        pipeline.stopAllTracking()
    }
}
