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
import { createConvexOrderPersistenceAdapter } from "@valiq-trading/convex"
import type { StoredStrategy } from "@valiq-trading/convex"
import {
    ExecutionPipeline,
    createInstrumentConflictValidator,
    createKillSwitchGuardedVenue as createRuntimeKillSwitchGuardedVenue,
    filterPositionsByOwnership,
    getNextCronFireMs,
    parseSummaryMetadata,
    stripMetadataBlock,
    validatePolicy,
    type Scheduler,
    type VenueAdapter,
} from "@valiq-trading/core"
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
        if (!resolvedSecrets.OPENROUTER_API_KEY) {
            throw new Error("Cannot run strategy: OPENROUTER_API_KEY is not set in Convex environment variables")
        }

        const [allPositions, accountState, previousRunSummary] = await Promise.all([
            venue.getPositions(),
            venue.getAccountState(),
            backend.getLastCompletedRunSummary(strategy._id),
        ])
        const positions = filterPositionsByOwnership(allPositions, ownedInstruments)

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
                schedule: strategy.schedule,
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
            }
        )

        const [allSyncedPositions, finalAccountState] = await Promise.all([
            venue.getPositions(),
            venue.getAccountState(),
        ])
        const syncedPositions = filterPositionsByOwnership(allSyncedPositions, ownedInstruments)
        await Promise.all([
            backend.syncPositions(strategy._id, app, syncedPositions),
            accountSnapshotPersisters[app](finalAccountState),
        ])

        if (plugin.postRunHooks) {
            await plugin.postRunHooks({
                venue,
                policy,
                strategyId: strategy._id,
                logger: runLogger,
                createAlert: (alert) => backend.createAlert(alert),
            })
        }

        const cleanSummary = result.summary
            ? stripMetadataBlock(result.summary)
            : result.summary

        if (result.error) {
            await backend.updateRun(runId, "failed", cleanSummary, result.error)
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
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await backend.updateRun(runId, "failed", undefined, message)
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
