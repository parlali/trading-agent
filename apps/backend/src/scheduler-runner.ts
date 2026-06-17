import {
    executeAgentRun,
    type ToolManifestEntry,
} from "@valiq-trading/agent"
import type {
    CreateRunMetadata,
    Id,
    RunDiagnostics,
    RunTrigger,
    StoredStrategy,
} from "@valiq-trading/convex"
import {
    getNextCronFireMs,
    parseSummaryMetadata,
    sanitizeRunSummary,
    resolveStrategyLlmConfig,
    withTimeout,
    type AccountState,
    type RunSystemContextDigest,
    type Scheduler,
    type StrategyLlmConfig,
} from "@valiq-trading/core"
import type { VenueApp, VenuePlugin } from "./types"
import { createAgentProviderConfig } from "./scheduler-provider-config"
import { assertStrategyLlmProviderCanRun } from "./scheduler-provider-gates"
import {
    backend,
    logger,
    healthState,
} from "./state"
import { reconcileProviderPortfolio, recordProviderSyncFailure } from "./provider-sync"
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
} from "./scheduler-run-support"
import {
    createScheduledRunRuntime,
    prepareScheduledRunAgentTurn,
    resolveScheduledRunRiskSnapshot,
    type ScheduledRunRuntime,
} from "./scheduled-run-runtime"

interface RunStrategyOptions {
    userMessage?: string
    abortSignal?: AbortSignal
    createRunMetadata?: CreateRunMetadata
    failOnSkippedStart?: boolean
}

export interface StrategyRunOutcome {
    runId?: string
    status: "completed" | "failed" | "skipped"
    summary?: string
    error?: string
}

export async function runStrategy(
    app: VenueApp,
    plugin: VenuePlugin,
    strategy: StoredStrategy,
    policy: Record<string, unknown>,
    strategySecrets: Record<string, string | null>,
    scheduler?: Scheduler,
    trigger: RunTrigger = "cron",
    options: RunStrategyOptions = {}
): Promise<StrategyRunOutcome | undefined> {
    const accountHealth = healthState.venues[app]?.accounts?.[strategy.accountId]
    if (accountHealth?.validated !== true) {
        const message = `${app}:${strategy.accountId} environment not validated${accountHealth?.error ? ` (${accountHealth.error})` : ""}`
        logger.warn("Run skipped because venue environment is not validated", {
            strategyId: strategy._id,
            app,
            accountId: strategy.accountId,
            trigger,
            validationError: accountHealth?.error ?? healthState.venues[app]?.error,
        })
        await backend.createAlert({
            strategyId: strategy._id,
            app,
            severity: "warning",
            message: `Strategy run skipped: ${message}`,
        })
        if (options.failOnSkippedStart) {
            throw new Error(`Strategy run skipped: ${message}`)
        }
        return {
            status: "skipped",
            error: message,
        }
    }

    if (await checkKillSwitch(app, `pre-run:${strategy._id}`)) {
        const message = "kill switch active"
        logger.warn("Run skipped due to active kill switch", { strategyId: strategy._id, app })
        await backend.createAlert({
            strategyId: strategy._id,
            app,
            severity: "warning",
            message: "Strategy run skipped: kill switch active",
        })
        if (options.failOnSkippedStart) {
            throw new Error(`Strategy run skipped: ${message}`)
        }
        return {
            status: "skipped",
            error: message,
        }
    }

    const llmConfig = resolveStrategyLlmConfig(policy)
    const runId = await backend.createRun(strategy._id, app, trigger, options.createRunMetadata)
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
        app,
    })

    let runtime: ScheduledRunRuntime | undefined
    let runSystemContextDigest: RunSystemContextDigest | undefined
    let currentAccountState: AccountState | undefined
    let runtimeContextLines: string[] | undefined
    let registeredToolManifest: ToolManifestEntry[] = []
    let mcpToolDiagnostics: RunDiagnostics["mcpToolDiagnostics"] = []

    try {
        runtime = await createScheduledRunRuntime({
            app,
            plugin,
            strategy,
            policy,
            strategySecrets,
            runId,
            runLogger,
        })
        const activeRuntime = runtime
        const activePipeline = activeRuntime.pipeline

        if (plugin.preRunHooks) {
            const hookResult = await withTimeout(
                async () => await plugin.preRunHooks!({
                    venue: activeRuntime.venue,
                    policy,
                    strategyId: strategy._id,
                    ownedInstruments: activeRuntime.ownedInstruments,
                    ownedPositions: activeRuntime.initialOwnedPositions,
                    ownedWorkingOrders: activeRuntime.initialOwnedWorkingOrders,
                    strategyAccountState: activeRuntime.initialStrategyAccountState,
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
                if (hookResult.providerStateChanged && !activeRuntime.isDryRun) {
                    const reconciliation = await reconcileProviderPortfolio({
                        app,
                        accountId: strategy.accountId,
                        venueName: plugin.venueName,
                        source: "post_run_sync",
                        venue: activeRuntime.venue,
                    })
                    const remainingOwnedWorkingOrders = findRemainingOwnedWorkingOrdersAfterSessionFlat(
                        reconciliation.workingOrders,
                        activeRuntime.ownershipScope
                    )
                    const remainingOwnedPositions = findRemainingOwnedPositionsAfterSessionFlat(
                        reconciliation.positions,
                        activeRuntime.ownershipScope
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
                await refreshOperationalMemoryForCompletedRun(runId, strategy._id, app)
                updateHealth("completed", summary)
                return {
                    runId,
                    status: "completed",
                    summary,
                }
            }

            runtimeContextLines = hookResult.runtimeContextLines
        }

        const riskSnapshot = await resolveScheduledRunRiskSnapshot(activeRuntime)
        const runRiskState = riskSnapshot.riskState

        assertStrategyLlmProviderCanRun(llmConfig, policy, strategySecrets, {
            env: process.env,
        })

        const isCallback = trigger === "callback"
        const strategyRunStartedAt = Date.now()

        return await withTimeout(async (): Promise<StrategyRunOutcome> => {
            const preparedTurn = await prepareScheduledRunAgentTurn(activeRuntime, {
                trigger,
                isCallback,
                safetyPolicy: riskSnapshot.safetyPolicy,
                riskState: runRiskState,
                runtimeContextLines,
            })
            runSystemContextDigest = preparedTurn.runSystemContextDigest
            registeredToolManifest = preparedTurn.toolManifest
            mcpToolDiagnostics = preparedTurn.mcpToolDiagnostics
            currentAccountState = preparedTurn.context.accountState

            const result = await executeAgentRun(
                preparedTurn.context,
                {
                    provider: createAgentProviderConfig(llmConfig, strategySecrets),
                    tools: preparedTurn.tools,
                    logger: runLogger,
                    agentLogger: backend,
                    killSwitchChecker: () => checkKillSwitch(app, `mid-run:${strategy._id}`),
                    runTimeoutMs: Math.max(1, STRATEGY_RUN_TIMEOUT_MS - (Date.now() - strategyRunStartedAt)),
                    userMessage: options.userMessage,
                    abortSignal: options.abortSignal,
                }
            )

            if (plugin.postRunHooks) {
                await withTimeout(
                    async () => await plugin.postRunHooks!({
                        venue: activeRuntime.venue,
                        policy,
                        strategyId: strategy._id,
                        logger: runLogger,
                        createAlert: (alert) => backend.createAlert(alert),
                    }),
                    POST_RUN_HOOK_TIMEOUT_MS,
                    `post-run hooks for strategy ${strategy._id}`
                )
            }

            if (activeRuntime.isDryRun) {
                const syncedPositions = activePipeline.getDryRunPositionsForSync()
                await backend.syncPositions(strategy._id, app, syncedPositions)
            } else {
                await reconcileProviderPortfolio({
                    app,
                    accountId: strategy.accountId,
                    venueName: plugin.venueName,
                    source: "post_run_sync",
                    venue: activeRuntime.venue,
                })
            }

            currentAccountState = await activePipeline.getAccountState()
            await resolveScheduledRunRiskSnapshot(activeRuntime, currentAccountState)

            const cleanSummary = result.summary
                ? sanitizeRunSummary(result.summary)
                : result.summary
            const runDiagnostics = buildRunDiagnostics(result, runSystemContextDigest) ?? {}
            if (mcpToolDiagnostics.length > 0) {
                runDiagnostics.mcpToolDiagnostics = mcpToolDiagnostics
            }

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
                return {
                    runId,
                    status: "failed",
                    summary: cleanSummary,
                    error: result.error,
                }
            }

            await backend.updateRun(runId, "completed", cleanSummary, undefined, runDiagnostics)
            await refreshOperationalMemoryForCompletedRun(runId, strategy._id, app)
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

            return {
                runId,
                status: "completed",
                summary: cleanSummary,
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
                buildFailureRunDiagnostics(llmConfig, runSystemContextDigest, registeredToolManifest, mcpToolDiagnostics)
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
            if (runtime?.isDryRun) {
                await backend.syncPositions(strategy._id, app, runtime.pipeline.getDryRunPositionsForSync())
            } else if (runtime && !runtime.isDryRun) {
                await reconcileProviderPortfolio({
                    app,
                    accountId: strategy.accountId,
                    venueName: plugin.venueName,
                    source: "post_run_sync",
                    venue: runtime.venue,
                })
            }
        } catch (syncError) {
            const syncMessage = syncError instanceof Error ? syncError.message : String(syncError)
            if (!Boolean(policy.dryRun)) {
                await recordProviderSyncFailure(app, strategy.accountId, syncMessage)
            }
        }

        try {
            if (runtime) {
                currentAccountState = await runtime.pipeline.getAccountState()
            }
        } catch (accountStateError) {
            logger.warn("Failed to refresh account state before risk update after run failure", {
                strategyId: strategy._id,
                app,
                error: accountStateError instanceof Error ? accountStateError.message : String(accountStateError),
            })
        }

        try {
            if (runtime) {
                await resolveScheduledRunRiskSnapshot(runtime, currentAccountState)
            }
        } catch (riskRefreshError) {
            logger.warn("Failed to refresh strategy risk state after run failure", {
                strategyId: strategy._id,
                app,
                error: riskRefreshError instanceof Error ? riskRefreshError.message : String(riskRefreshError),
            })
        }

        throw error
    } finally {
        runtime?.cleanup()
    }
}

async function refreshOperationalMemoryForCompletedRun(
    runId: Id<"strategy_runs">,
    strategyId: Id<"strategies">,
    app: VenueApp
): Promise<void> {
    try {
        const result = await backend.refreshStrategyOperationalMemoryFromRun(runId)
        logger.info("Refreshed strategy operational memory", {
            runId,
            strategyId,
            app,
            upserted: result.upserted,
            skipped: result.skipped,
        })
    } catch (error) {
        logger.warn("Strategy operational memory refresh failed after completed run", {
            runId,
            strategyId,
            app,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

function buildFailureRunDiagnostics(
    llmConfig: StrategyLlmConfig,
    systemContextDigest?: RunSystemContextDigest,
    toolManifest: ToolManifestEntry[] = [],
    mcpToolDiagnostics: RunDiagnostics["mcpToolDiagnostics"] = []
): RunDiagnostics {
    const diagnostics: RunDiagnostics = {
        llmProvider: llmConfig.provider,
        llmModel: llmConfig.model,
        llmResponseIds: [],
    }

    if (llmConfig.provider === "openrouter") {
        diagnostics.llmBillingMode = "openrouter"
        diagnostics.openRouterResponseIds = []
    } else {
        diagnostics.llmAuthMode = llmConfig.authMode
        diagnostics.llmBillingMode = "codex-subscription"
        diagnostics.codexTurnIds = []
    }

    if (systemContextDigest) {
        diagnostics.systemContextDigest = systemContextDigest
    }
    if (mcpToolDiagnostics.length > 0) {
        diagnostics.mcpToolDiagnostics = mcpToolDiagnostics
    }
    diagnostics.toolManifest = toolManifest

    return diagnostics
}
