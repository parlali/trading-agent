import {
    ToolRegistry,
    executeAgentRun,
    withCallBudget,
} from "@valiq-trading/agent"
import { createConvexOrderPersistenceAdapter } from "@valiq-trading/convex"
import type {
    RunTrigger,
    StoredStrategy,
} from "@valiq-trading/convex"
import {
    ExecutionPipeline,
    createInstrumentConflictValidator,
    createStrategySafetyValidator,
    buildRunSystemContextDigest,
    formatRunSystemContextDigestLines,
    filterPositionsByOwnershipScope,
    filterWorkingOrdersByOwnershipScope,
    getNextCronFireMs,
    parseSummaryMetadata,
    sanitizeRunSummary,
    computeRecentTradeDigest,
    isDryRunAccountLedgerPosition,
    resolveDryRunAccountState,
    resolveStrategyAccountState,
    withTimeout,
    type AccountState,
    type Position,
    type RunSystemContextDigest,
    type Scheduler,
    type StrategyRiskState,
    type WorkingOrder,
} from "@valiq-trading/core"
import type { VenueApp, VenuePlugin } from "./types"
import { buildToolPool } from "./scheduler-tool-pool"
import {
    buildPromptBlockedIdentifiers,
    mergeRuntimeContextLines,
    readPolicyReasoningConfig,
} from "./scheduler-context"
import {
    backend,
    convexUrl,
    backendServiceToken,
    logger,
    healthState,
} from "./state"
import { reconcileProviderPortfolio, recordProviderSyncFailure } from "./provider-sync"
import { reconcilePendingOrdersForRun } from "./pending-orders"
import {
    findRemainingOwnedPositionsAfterSessionFlat,
    findRemainingOwnedWorkingOrdersAfterSessionFlat,
} from "./session-flat-assertions"
import { executeAuditedSessionFlat } from "./session-flat"
import { updateHealth } from "./scheduler-health"
import {
    POST_RUN_HOOK_TIMEOUT_MS,
    PRE_RUN_HOOK_TIMEOUT_MS,
    STRATEGY_RUN_TIMEOUT_MS,
    buildRunDiagnostics,
    checkKillSwitch,
    createKillSwitchGuardedVenue,
    mergePendingOrderBlockedInstrumentsIntoRiskState,
    resolveRuntimeSafetyPolicyForRun,
} from "./scheduler-run-support"

export async function runStrategy(
    app: VenueApp,
    plugin: VenuePlugin,
    strategy: StoredStrategy,
    policy: Record<string, unknown>,
    strategySecrets: Record<string, string | null>,
    scheduler?: Scheduler,
    trigger: RunTrigger = "cron"
): Promise<void> {
    if (healthState.venues[app]?.validated !== true) {
        logger.warn("Run skipped because venue environment is not validated", {
            strategyId: strategy._id,
            app,
            trigger,
            validationError: healthState.venues[app]?.error,
        })
        await backend.createAlert({
            strategyId: strategy._id,
            app,
            severity: "warning",
            message: `Strategy run skipped: ${app} environment not validated${healthState.venues[app]?.error ? ` (${healthState.venues[app]?.error})` : ""}`,
        })
        return
    }

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
    const isDryRun = Boolean(policy.dryRun)
    const storedPositionsPromise = isDryRun
        ? backend.getLatestPositions(strategy._id)
        : Promise.resolve(undefined)
    const [
        ownershipScopeRow,
        allOwnedInstruments,
        storedPositions,
    ] = await Promise.all([
        backend.getStrategyOwnershipScope(strategy._id),
        backend.getAllOwnedInstrumentsByApp(app),
        storedPositionsPromise,
    ])
    let initialPositions: Position[]
    let initialWorkingOrders: WorkingOrder[]
    let initialProviderAccountState: AccountState | undefined

    if (isDryRun) {
        initialPositions = storedPositions ?? []
        initialWorkingOrders = []
        initialProviderAccountState = undefined
    } else if (app === "mt5") {
        initialPositions = await venue.getPositions()
        initialWorkingOrders = venue.getWorkingOrders ? await venue.getWorkingOrders() : []
        initialProviderAccountState = await venue.getAccountState()
    } else {
        [
            initialPositions,
            initialWorkingOrders,
            initialProviderAccountState,
        ] = await Promise.all([
            venue.getPositions(),
            venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
            venue.getAccountState(),
        ])
    }
    const ownershipScope = {
        instruments: new Set(ownershipScopeRow.instruments),
        positionKeys: new Set(ownershipScopeRow.positionKeys),
        workingOrderIds: new Set(ownershipScopeRow.workingOrderIds),
    }
    const ownedInstruments = ownershipScope.instruments
    const initialOwnedPositions = isDryRun
        ? (initialPositions ?? []).filter((position) => !isDryRunAccountLedgerPosition(position))
        : filterPositionsByOwnershipScope(initialPositions ?? [], ownershipScope)
    const initialOwnedWorkingOrders = filterWorkingOrdersByOwnershipScope(initialWorkingOrders, ownershipScope)
    const initialStrategyAccountState = isDryRun
        ? resolveDryRunAccountState({
            policy,
            positions: storedPositions ?? [],
        })
        : resolveStrategyAccountState({
            providerAccountState: initialProviderAccountState!,
            positions: initialOwnedPositions,
            policy,
        })
    const runId = await backend.createRun(strategy._id, app, trigger)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
        app,
    })

    let pipeline: ExecutionPipeline | undefined
    let runSystemContextDigest: RunSystemContextDigest | undefined
    let latestStoredPositions: Position[] | undefined
    let currentAccountState: AccountState | undefined
    let runtimeContextLines: string[] | undefined

    try {
        latestStoredPositions = storedPositions

        const conflictMap = new Map<string, string>()
        for (const entry of allOwnedInstruments) {
            if (entry.strategyId !== strategy._id) {
                conflictMap.set(entry.instrument, entry.strategyId)
            }
        }

        const pluginValidators = plugin.getRiskValidators()
        const orderPersistence = createConvexOrderPersistenceAdapter({
            url: convexUrl,
            machineAuth: {
                serviceToken: backendServiceToken,
            },
        })
        const guardedVenue = createKillSwitchGuardedVenue(venue, app, strategy._id)

        pipeline = new ExecutionPipeline({
            venue: guardedVenue,
            venueName: plugin.venueName,
            policy,
            riskValidators: pluginValidators,
            logger: runLogger,
            tradeEventLogger: backend,
            orderPersistence,
            priceVerification: {
                failClosedOnVerificationError: app === "polymarket",
            },
            runId,
            strategyId: strategy._id,
            ownedInstruments,
            ownershipScope,
            strategyRealizedPnl: 0,
            executionSafetyFaultRecorder: async (fault) => {
                await backend.recordExecutionSafetyFault({
                    strategyId: strategy._id,
                    app,
                    instrument: fault.instrument,
                    category: fault.category ?? "commit_unknown",
                    message: fault.message,
                    providerPayload: fault.providerPayload,
                    canonicalOrderId: fault.canonicalOrderId,
                    providerOrderId: fault.providerOrderId,
                    providerClientOrderId: fault.providerClientOrderId,
                    providerOrderAliases: fault.providerOrderAliases,
                    submitAttemptId: fault.submitAttemptId,
                    submitAttemptSequence: fault.submitAttemptSequence,
                    runId,
                    venue: fault.venue,
                    signedOrderFingerprint: fault.signedOrderFingerprint,
                    recoveryProbeEvidence: fault.recoveryProbeEvidence,
                    blocked: true,
                })
                runLogger.error("Recorded execution safety fault", {
                    strategyId: strategy._id,
                    runId,
                    app,
                    instrument: fault.instrument,
                    category: fault.category ?? "commit_unknown",
                    canonicalOrderId: fault.canonicalOrderId,
                    submitAttemptId: fault.submitAttemptId,
                })
            },
        })
        const activePipeline = pipeline

        if (plugin.preRunHooks) {
            const hookResult = await withTimeout(
                async () => await plugin.preRunHooks!({
                    venue,
                    policy,
                    strategyId: strategy._id,
                    ownedInstruments,
                    ownedPositions: initialOwnedPositions,
                    ownedWorkingOrders: initialOwnedWorkingOrders,
                    strategyAccountState: initialStrategyAccountState,
                    logger: runLogger,
                    createAlert: (alert) => backend.createAlert(alert),
                    sessionFlat: {
                        execute: async (args) => await executeAuditedSessionFlat({
                            pipeline: activePipeline,
                            logger: runLogger,
                            strategyId: strategy._id,
                            app,
                            positions: args.positions,
                            workingOrders: args.workingOrders,
                            reason: args.reason,
                        }),
                    },
                }),
                PRE_RUN_HOOK_TIMEOUT_MS,
                `pre-run hooks for strategy ${strategy._id}`
            )
            if (hookResult.skip) {
                runLogger.warn("Pre-run hook skipped strategy", {
                    strategyId: strategy._id,
                    app,
                    reason: hookResult.reason,
                })
                if (hookResult.providerStateChanged && !isDryRun) {
                    const reconciliation = await reconcileProviderPortfolio({
                        app,
                        venueName: plugin.venueName,
                        source: "post_run_sync",
                        venue,
                    })
                    const remainingOwnedWorkingOrders = findRemainingOwnedWorkingOrdersAfterSessionFlat(
                        reconciliation.workingOrders,
                        ownershipScope
                    )
                    const remainingOwnedPositions = findRemainingOwnedPositionsAfterSessionFlat(
                        reconciliation.positions,
                        ownershipScope
                    )

                    if (remainingOwnedWorkingOrders.length > 0) {
                        const orderIds = remainingOwnedWorkingOrders.map((order) => order.orderId).join(", ")
                        await backend.createAlert({
                            strategyId: strategy._id,
                            app,
                            severity: "critical",
                            message: `Session-flat provider-sync assertion failed: ${remainingOwnedWorkingOrders.length} owned working order(s) still live after flat/cancel for ${strategy.name}: ${orderIds}`,
                        })
                        throw new Error(`Session-flat provider-sync assertion failed for ${strategy.name}: owned working order(s) still live after flat/cancel: ${orderIds}`)
                    }

                    if (remainingOwnedPositions.length > 0) {
                        const positionIds = remainingOwnedPositions.map((position) =>
                            position.providerPositionId ?? `${position.instrument}:${position.side}`
                        ).join(", ")
                        await backend.createAlert({
                            strategyId: strategy._id,
                            app,
                            severity: "critical",
                            message: `Session-flat provider-sync assertion failed: ${remainingOwnedPositions.length} owned position(s) still live after flat/cancel for ${strategy.name}: ${positionIds}`,
                        })
                        throw new Error(`Session-flat provider-sync assertion failed for ${strategy.name}: owned position(s) still live after flat/cancel: ${positionIds}`)
                    }
                }

                const summary = hookResult.reason ?? "Strategy skipped by pre-run hook"
                await backend.updateRun(runId, "completed", summary)
                updateHealth("completed", summary)
                return
            }

            runtimeContextLines = hookResult.runtimeContextLines
        }

        const preRunSafetyPolicy = await resolveRuntimeSafetyPolicyForRun({
            policy,
            venue,
            latestStoredPositions,
            accountState: initialStrategyAccountState,
        })
        const riskState = await backend.refreshStrategyRiskState({
            strategyId: strategy._id,
            app,
            policy: preRunSafetyPolicy,
        })
        let runRiskState = riskState
        const buildRiskValidators = (currentRiskState: StrategyRiskState) => {
            const safetyValidator = createStrategySafetyValidator({
                safetyState: currentRiskState.safetyState,
                blockedInstruments: new Set(currentRiskState.blockedInstruments),
                reason: currentRiskState.cooldown.active
                    ? `Strategy cooldown active (${currentRiskState.cooldown.reason ?? "risk"})`
                    : undefined,
                blockedInstrumentReason: currentRiskState.cooldown.active
                    ? `Instrument is blocked because strategy cooldown is active (${currentRiskState.cooldown.reason ?? "risk"}). Only risk-reducing actions are allowed until the cooldown expires.`
                    : undefined,
            })

            return conflictMap.size > 0
                ? [safetyValidator, ...pluginValidators, createInstrumentConflictValidator(conflictMap)]
                : [safetyValidator, ...pluginValidators]
        }

        activePipeline.setRiskValidators(buildRiskValidators(runRiskState))
        activePipeline.setStrategyRealizedPnl(runRiskState.day.realizedPnl)

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
            strategyId: strategy._id,
            venue,
            pipeline: activePipeline,
            policy,
            extraTools: budgetedExtraTools,
            isCallback,
            runLogger,
        })
        const tools = new ToolRegistry()
        for (const tool of toolPool.forVenue(app)) {
            tools.register(tool)
        }

        await withTimeout(async () => {
            if (!strategySecrets.OPENROUTER_API_KEY) {
                throw new Error("Cannot run strategy: OPENROUTER_API_KEY is not set in Convex environment variables")
            }

            const isDryRun = Boolean(policy.dryRun)
            const {
                pendingOrders,
                runtimeContextLines: pendingOrderRuntimeContext,
                blockedInstruments: pendingOrderBlockedInstruments,
            } = await reconcilePendingOrdersForRun(
                activePipeline,
                strategy._id,
                orderPersistence,
                runLogger
            )
            runtimeContextLines = mergeRuntimeContextLines(runtimeContextLines, pendingOrderRuntimeContext)
            if (pendingOrderBlockedInstruments.length > 0) {
                runRiskState = mergePendingOrderBlockedInstrumentsIntoRiskState(
                    runRiskState,
                    pendingOrderBlockedInstruments
                )
                activePipeline.setRiskValidators(buildRiskValidators(runRiskState))
            }

            const runTimestamp = Date.now()
            const [allPositions, previousRunSummary, recentOrderHistory] = await Promise.all([
                isDryRun ? Promise.resolve(latestStoredPositions ?? []) : venue.getPositions(),
                backend.getLastCompletedRunSummary(strategy._id),
                backend.getStrategyOrderHistory(strategy._id, 250),
            ])
            const recentTrades = computeRecentTradeDigest({
                orders: recentOrderHistory,
                timezone: preRunSafetyPolicy.strategyTimezone,
                timestamp: runTimestamp,
            })
            runSystemContextDigest = buildRunSystemContextDigest({
                generatedAt: runTimestamp,
                riskState: runRiskState,
                recentTrades,
                pendingOrders,
            })
            runtimeContextLines = mergeRuntimeContextLines(
                runtimeContextLines,
                formatRunSystemContextDigestLines(runSystemContextDigest)
            )

            if (isDryRun) {
                activePipeline.seedDryRunPositions(allPositions)
            }

            const positions = isDryRun
                ? activePipeline.getDryRunPositions()
                : filterPositionsByOwnershipScope(allPositions, ownershipScope)
            const accountState = await activePipeline.getAccountState()
            currentAccountState = accountState

            const result = await executeAgentRun(
                {
                    runId,
                    strategyId: strategy._id,
                    app,
                    timestamp: runTimestamp,
                    trigger,
                    positions,
                    accountState,
                    policy,
                    context: strategy.context,
                    runtimeContextLines,
                    schedule: strategy.schedule,
                    pendingOrders,
                    previousRunSummary: previousRunSummary ?? undefined,
                    promptSanitizer: {
                        blockedIdentifiers: buildPromptBlockedIdentifiers({
                            allPositions,
                            ownedPositions: positions,
                            allWorkingOrders: initialWorkingOrders,
                            ownedWorkingOrders: initialOwnedWorkingOrders,
                            policy,
                        }),
                    },
                },
                {
                    llm: {
                        apiKey: strategySecrets.OPENROUTER_API_KEY,
                        model: policy.model as string,
                        reasoning: readPolicyReasoningConfig(policy),
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
                const syncedPositions = activePipeline.getDryRunPositionsForSync()
                await backend.syncPositions(strategy._id, app, syncedPositions)
            } else {
                await reconcileProviderPortfolio({
                    app,
                    venueName: plugin.venueName,
                    source: "post_run_sync",
                    venue,
                })
            }

            currentAccountState = await activePipeline.getAccountState()
            const postRunSafetyPolicy = await resolveRuntimeSafetyPolicyForRun({
                policy,
                venue,
                latestStoredPositions,
                accountState: currentAccountState,
            })
            await backend.refreshStrategyRiskState({
                strategyId: strategy._id,
                app,
                policy: postRunSafetyPolicy,
            })

            const cleanSummary = result.summary
                ? sanitizeRunSummary(result.summary)
                : result.summary
            const runDiagnostics = buildRunDiagnostics(result, runSystemContextDigest)

            if (result.error) {
                await Promise.all([
                    backend.updateRun(runId, "failed", cleanSummary, result.error, runDiagnostics),
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

            await backend.updateRun(runId, "completed", cleanSummary, undefined, runDiagnostics)
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
            backend.updateRun(
                runId,
                "failed",
                undefined,
                message,
                runSystemContextDigest
                    ? { systemContextDigest: runSystemContextDigest }
                    : undefined
            ),
            backend.createAlert({
                strategyId: strategy._id,
                app,
                severity: "critical",
                message: `Strategy run crashed: ${message}`,
            }),
        ])
        updateHealth("failed", undefined, message)

        try {
            if (Boolean(policy.dryRun) && pipeline) {
                await backend.syncPositions(strategy._id, app, pipeline.getDryRunPositionsForSync())
            } else if (!Boolean(policy.dryRun)) {
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

        try {
            if (pipeline) {
                currentAccountState = await pipeline.getAccountState()
            }
        } catch (accountStateError) {
            logger.warn("Failed to refresh account state before risk update after run failure", {
                strategyId: strategy._id,
                app,
                error: accountStateError instanceof Error ? accountStateError.message : String(accountStateError),
            })
        }

        try {
            const postFailureSafetyPolicy = await resolveRuntimeSafetyPolicyForRun({
                policy,
                venue,
                latestStoredPositions,
                accountState: currentAccountState,
            })
            await backend.refreshStrategyRiskState({
                strategyId: strategy._id,
                app,
                policy: postFailureSafetyPolicy,
            })
        } catch (riskRefreshError) {
            logger.warn("Failed to refresh strategy risk state after run failure", {
                strategyId: strategy._id,
                app,
                error: riskRefreshError instanceof Error ? riskRefreshError.message : String(riskRefreshError),
            })
        }

        throw error
    } finally {
        pipeline?.stopAllTracking()
    }
}
