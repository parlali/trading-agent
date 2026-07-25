import {
    executeAgentRun,
    type CodexChatGptAuthRefreshSnapshot,
    type ToolManifestEntry,
} from "@valiq-trading/agent"
import type {
    AgentLogEntryInput,
    AgentLogMemoryEntry,
    CreateRunMetadata,
    Id,
    RunDiagnostics,
    RunTrigger,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"
import {
    getNextCronFireMs,
    isWithinSessionFlatWindow,
    MIN_ONESHOT_GAP_MS,
    parseSummaryMetadata,
    resolveTradingHoursWindowState,
    sanitizeRunSummary,
    resolveStrategyLlmConfig,
    withTimeout,
    type AccountState,
    type Logger,
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
    type AgentRunTranscriptMessage,
    buildRunDecisionRecord,
    buildRunDiagnostics,
    checkKillSwitch,
} from "./scheduler-run-support"
import {
    createScheduledRunRuntime,
    prepareScheduledRunAgentTurn,
    resolveScheduledRunRiskSnapshot,
    type ScheduledRunRuntime,
} from "./scheduled-run-runtime"
import { persistCodexChatGptAuthToControlPlane } from "./codex-auth-persistence"

interface RunStrategyOptions {
    userMessage?: string
    abortSignal?: AbortSignal
    createRunMetadata?: CreateRunMetadata
    failOnSkippedStart?: boolean
}

const AGENT_TRANSCRIPT_BATCH_SIZE = 25
const AGENT_TRANSCRIPT_FLUSH_AGE_MS = 2_500
const OPERATIONAL_MEMORY_AGENT_LOG_PAYLOAD_LIMIT_BYTES = 4 * 1024 * 1024
const CHEAP_FAILURE_TOOL_CALL_THRESHOLD = 1
const FAILURE_RECOVERY_MAX_DELAY_MS = 10 * 60 * 1000
const FAILURE_RECOVERY_BASE_DELAY_MS = 9 * 60 * 1000

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
    const agentTranscript = createBufferedAgentTranscriptLogger({
        backend,
        logger: runLogger,
        runId,
        strategyId: strategy._id,
    })

    let runtime: ScheduledRunRuntime | undefined
    let runSystemContextDigest: RunSystemContextDigest | undefined
    let currentAccountState: AccountState | undefined
    let runtimeContextLines: string[] | undefined
    let registeredToolManifest: ToolManifestEntry[] = []
    let mcpToolDiagnostics: RunDiagnostics["mcpToolDiagnostics"] = []
    let observedToolCallCount = 0
    let failureRecoveryFollowUpScheduled = false

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
                await refreshOperationalMemoryForCompletedRun(runId, strategy._id, app, agentTranscript)
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
                llmProvider: llmConfig.provider,
            })
            runSystemContextDigest = preparedTurn.runSystemContextDigest
            registeredToolManifest = preparedTurn.toolManifest
            mcpToolDiagnostics = preparedTurn.mcpToolDiagnostics
            currentAccountState = preparedTurn.context.accountState

            const providerConfig = createAgentProviderConfig(llmConfig, strategySecrets)
            const runtimeProviderConfig = providerConfig.provider === "codex" && providerConfig.authMode === "chatgpt"
                ? {
                    ...providerConfig,
                    onChatGptAuthRefreshed: async (auth: CodexChatGptAuthRefreshSnapshot) => {
                        await persistCodexChatGptAuthToControlPlane({
                            backend,
                            auth: {
                                ...auth,
                                lastRefresh: auth.lastRefresh ?? null,
                            },
                            logger: runLogger,
                        })
                    },
                }
                : providerConfig

            const result = await executeAgentRun(
                preparedTurn.context,
                {
                    provider: runtimeProviderConfig,
                    tools: preparedTurn.tools,
                    logger: runLogger,
                    agentLogger: agentTranscript,
                    killSwitchChecker: () => checkKillSwitch(app, `mid-run:${strategy._id}`),
                    runTimeoutMs: Math.max(1, STRATEGY_RUN_TIMEOUT_MS - (Date.now() - strategyRunStartedAt)),
                    userMessage: options.userMessage,
                    abortSignal: options.abortSignal,
                    onToolCallCountChanged: (toolCallCount) => {
                        observedToolCallCount = toolCallCount
                    },
                }
            )
            observedToolCallCount = result.toolCallCount
            await flushAgentTranscriptForRun(agentTranscript, runLogger, runId, strategy._id)

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
            const decisionRecord = buildRunDecisionRecord(policy, result.summary, agentTranscript.getTranscriptMessages())
            if (decisionRecord !== undefined) {
                runDiagnostics.decisionRecord = decisionRecord
            }
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
                if (!failureRecoveryFollowUpScheduled) {
                    failureRecoveryFollowUpScheduled = await scheduleFailureRecoveryOneshot({
                        app,
                        plugin,
                        strategy,
                        policy,
                        strategySecrets,
                        scheduler,
                        trigger,
                        runId,
                        runtime: activeRuntime,
                        toolCallCount: result.toolCallCount,
                        error: result.error,
                    })
                }
                return {
                    runId,
                    status: "failed",
                    summary: cleanSummary,
                    error: result.error,
                }
            }

            await backend.updateRun(runId, "completed", cleanSummary, undefined, runDiagnostics)
            await refreshOperationalMemoryForCompletedRun(runId, strategy._id, app, agentTranscript)
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
                buildFailureRunDiagnostics(
                    llmConfig,
                    runSystemContextDigest,
                    registeredToolManifest,
                    mcpToolDiagnostics,
                    observedToolCallCount
                )
            ),
            backend.createAlert({
                strategyId: strategy._id,
                app,
                severity: "critical",
                message: `Strategy run crashed: ${message}`,
            }),
        ])
        updateHealth("failed", undefined, message)
        if (!failureRecoveryFollowUpScheduled) {
            failureRecoveryFollowUpScheduled = await scheduleFailureRecoveryOneshot({
                app,
                plugin,
                strategy,
                policy,
                strategySecrets,
                scheduler,
                trigger,
                runId,
                runtime,
                toolCallCount: observedToolCallCount,
                error: message,
            })
        }

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
        await flushAgentTranscriptForRun(agentTranscript, runLogger, runId, strategy._id)
        agentTranscript.dispose()
        runtime?.cleanup()
    }
}

type FailureRecoveryReason = "cheap_failure" | "supervision_recovery"

type RecoveryFireWindowGuard = {
    allowed: true
} | {
    allowed: false
    reason: string
    detail?: string
}

type RecoveryDelayDecision = {
    allowed: true
    delayMs: number
    firesAt: number
} | {
    allowed: false
    reason: string
    detail?: string
}

interface FailureRecoveryOneshotArgs {
    app: VenueApp
    plugin: VenuePlugin
    strategy: StoredStrategy
    policy: Record<string, unknown>
    strategySecrets: Record<string, string | null>
    scheduler?: Scheduler
    trigger: RunTrigger
    runId: Id<"strategy_runs">
    runtime?: ScheduledRunRuntime
    toolCallCount: number
    error: string
}

interface TradingHoursPolicy {
    start: string
    end: string
    timezone: string
}

async function scheduleFailureRecoveryOneshot(args: FailureRecoveryOneshotArgs): Promise<boolean> {
    if (!args.scheduler || args.trigger !== "cron") {
        return false
    }
    const scheduler = args.scheduler

    const exposure = resolveRuntimeSupervisionExposure(args.runtime)
    const recoveryReasons = resolveFailureRecoveryReasons({
        toolCallCount: args.toolCallCount,
        openPositionCount: exposure.openPositionCount,
        workingOrderCount: exposure.workingOrderCount,
    })
    if (recoveryReasons.length === 0) {
        return false
    }

    try {
        if (await checkKillSwitch(args.app, `pre-run:${args.strategy._id}`)) {
            logger.info("Failure recovery follow-up suppressed", {
                strategyId: args.strategy._id,
                runId: args.runId,
                app: args.app,
                reason: "kill_switch_active",
            })
            return false
        }

        const suiteLossState = await backend.getSuiteLossState()
        if (suiteLossState.blocked) {
            logger.info("Failure recovery follow-up suppressed", {
                strategyId: args.strategy._id,
                runId: args.runId,
                app: args.app,
                reason: "suite_loss_blocked",
                suiteLossReason: suiteLossState.reason,
            })
            return false
        }

        const delay = resolveFailureRecoveryDelay(args.policy, Date.now())
        if (!delay.allowed) {
            logger.info("Failure recovery follow-up suppressed", {
                strategyId: args.strategy._id,
                runId: args.runId,
                app: args.app,
                reason: delay.reason,
                detail: delay.detail,
            })
            return false
        }

        scheduler.scheduleOneshot(args.strategy._id, delay.delayMs, async () => {
            await runStrategy(
                args.app,
                args.plugin,
                args.strategy,
                args.policy,
                args.strategySecrets,
                scheduler,
                "callback"
            )
        })
        await recordFailureRecoveryTelemetry({
            ...args,
            delayMs: delay.delayMs,
            firesAt: delay.firesAt,
            recoveryReasons,
            openPositionCount: exposure.openPositionCount,
            workingOrderCount: exposure.workingOrderCount,
        })

        return true
    } catch (error) {
        logger.error("Failure recovery follow-up scheduling failed", {
            strategyId: args.strategy._id,
            runId: args.runId,
            app: args.app,
            error: error instanceof Error ? error.message : String(error),
        })
        return false
    }
}

async function recordFailureRecoveryTelemetry(args: FailureRecoveryOneshotArgs & {
    delayMs: number
    firesAt: number
    recoveryReasons: FailureRecoveryReason[]
    openPositionCount: number
    workingOrderCount: number
}): Promise<void> {
    void backend.recordRunCallback(
        args.runId,
        args.delayMs / 60_000,
        args.firesAt
    ).catch((error) => {
        logger.warn("Failure recovery callback persistence failed", {
            strategyId: args.strategy._id,
            runId: args.runId,
            app: args.app,
            error: error instanceof Error ? error.message : String(error),
        })
    })

    logger.info("Failure recovery follow-up scheduled", {
        strategyId: args.strategy._id,
        runId: args.runId,
        app: args.app,
        delayMs: args.delayMs,
        firesAt: args.firesAt,
        reasons: args.recoveryReasons,
        toolCallCount: args.toolCallCount,
        openPositions: args.openPositionCount,
        workingOrders: args.workingOrderCount,
        failureError: args.error,
    })
    try {
        await backend.createAlert({
            strategyId: args.strategy._id,
            app: args.app,
            severity: "info",
            message: `Failure recovery follow-up scheduled for ${args.strategy.name}: retry in ${args.delayMs / 60_000} minute(s); reasons=${args.recoveryReasons.join(",")}; toolCalls=${args.toolCallCount}; openPositions=${args.openPositionCount}; workingOrders=${args.workingOrderCount}`,
        })
    } catch (error) {
        logger.error("Failure recovery follow-up alert failed", {
            strategyId: args.strategy._id,
            runId: args.runId,
            app: args.app,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

function resolveFailureRecoveryReasons(args: {
    toolCallCount: number
    openPositionCount: number
    workingOrderCount: number
}): FailureRecoveryReason[] {
    const reasons: FailureRecoveryReason[] = []
    if (args.toolCallCount <= CHEAP_FAILURE_TOOL_CALL_THRESHOLD) {
        reasons.push("cheap_failure")
    }
    if (args.openPositionCount > 0 || args.workingOrderCount > 0) {
        reasons.push("supervision_recovery")
    }

    return reasons
}

function resolveRuntimeSupervisionExposure(runtime?: ScheduledRunRuntime): {
    openPositionCount: number
    workingOrderCount: number
} {
    const openPositionCount = runtime?.initialOwnedPositions.filter((position) =>
        Math.abs(position.quantity) > 0
    ).length ?? 0
    const workingOrderCount = runtime?.initialOwnedWorkingOrders.filter((order) =>
        order.remainingQuantity > 0
    ).length ?? 0

    return {
        openPositionCount,
        workingOrderCount,
    }
}

function resolveFailureRecoveryDelay(policy: Record<string, unknown>, nowMs: number): RecoveryDelayDecision {
    let lastSuppression: RecoveryDelayDecision | undefined
    for (let delayMs = FAILURE_RECOVERY_BASE_DELAY_MS; delayMs <= FAILURE_RECOVERY_MAX_DELAY_MS; delayMs += 60_000) {
        const firesAt = nowMs + delayMs
        const guard = validateFailureRecoveryFireWindow(policy, firesAt)
        if (guard.allowed) {
            return {
                allowed: true,
                delayMs,
                firesAt,
            }
        }

        lastSuppression = {
            allowed: false,
            reason: guard.reason,
            detail: guard.detail,
        }
    }

    return lastSuppression ?? {
        allowed: false,
        reason: "no_eligible_recovery_window",
    }
}

function validateFailureRecoveryFireWindow(
    policy: Record<string, unknown>,
    firesAt: number
): RecoveryFireWindowGuard {
    const tradingHours = readTradingHoursPolicy(policy)
    if (!tradingHours) {
        return { allowed: true }
    }

    const windowState = resolveTradingHoursWindowState({
        ...tradingHours,
        timestamp: firesAt,
    })
    if (!windowState.withinWindow) {
        return {
            allowed: false,
            reason: "outside_trading_hours",
            detail: `target ${windowState.currentTime} ${tradingHours.timezone} outside ${tradingHours.start}-${tradingHours.end}`,
        }
    }

    const entryCutoffMinutesBeforeSessionEnd = readPositiveNumber(policy.entryCutoffMinutesBeforeSessionEnd)
    if (
        entryCutoffMinutesBeforeSessionEnd !== undefined &&
        windowState.minutesUntilEnd <= entryCutoffMinutesBeforeSessionEnd
    ) {
        return {
            allowed: false,
            reason: "entry_cutoff_window",
            detail: `target ${windowState.currentTime} ${tradingHours.timezone} has ${windowState.minutesUntilEnd} minute(s) until ${tradingHours.end}`,
        }
    }

    const sessionFlatPolicy = readSessionFlatPolicy(policy)
    if (sessionFlatPolicy?.enabled) {
        const flattenWindow = isWithinSessionFlatWindow({
            start: tradingHours.start,
            end: tradingHours.end,
            timezone: sessionFlatPolicy.timezone ?? tradingHours.timezone,
            closeBufferMinutes: sessionFlatPolicy.closeBufferMinutes,
            timestamp: firesAt,
        })
        if (flattenWindow.shouldFlatten) {
            return {
                allowed: false,
                reason: "session_flat_window",
                detail: `target ${flattenWindow.currentTime} ${sessionFlatPolicy.timezone ?? tradingHours.timezone} inside session-flat window before ${tradingHours.end}`,
            }
        }
    }

    return { allowed: true }
}

function readTradingHoursPolicy(policy: Record<string, unknown>): TradingHoursPolicy | undefined {
    if (!isRecord(policy.tradingHours)) {
        return undefined
    }

    const { start, end, timezone } = policy.tradingHours
    if (typeof start !== "string" || typeof end !== "string" || typeof timezone !== "string") {
        return undefined
    }

    return {
        start,
        end,
        timezone,
    }
}

function readSessionFlatPolicy(policy: Record<string, unknown>): {
    enabled: boolean
    closeBufferMinutes: number
    timezone?: string
} | undefined {
    if (!isRecord(policy.safety) || !isRecord(policy.safety.sessionFlat)) {
        return undefined
    }

    const { enabled, closeBufferMinutes, timezone } = policy.safety.sessionFlat
    if (enabled !== true || typeof closeBufferMinutes !== "number") {
        return undefined
    }

    return {
        enabled,
        closeBufferMinutes,
        timezone: typeof timezone === "string" ? timezone : undefined,
    }
}

function readPositiveNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

async function refreshOperationalMemoryForCompletedRun(
    runId: Id<"strategy_runs">,
    strategyId: Id<"strategies">,
    app: VenueApp,
    agentTranscript: BufferedAgentTranscriptLogger
): Promise<void> {
    try {
        const agentLogs = resolveAgentLogsForOperationalMemoryRefresh(agentTranscript, runId, strategyId, app)
        const result = await backend.refreshStrategyOperationalMemoryFromRun(runId, agentLogs)
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

interface BufferedAgentTranscriptLogger {
    log(
        runId: string,
        strategyId: string,
        sequence: number,
        role: string,
        content: string,
        toolName?: string,
        toolInput?: string,
        toolOutput?: string,
        toolCalls?: string
    ): Promise<void>
    flush(): Promise<void>
    dispose(): void
    getPersistedAgentLogs(): AgentLogMemoryEntry[]
    getTranscriptMessages(): AgentRunTranscriptMessage[]
    hasCompletePersistedTranscript(): boolean
}

type QueuedAgentLogEntry = AgentLogEntryInput & {
    queuedAt: number
}

function createBufferedAgentTranscriptLogger(args: {
    backend: TradingBackendClient
    logger: Logger
    runId: Id<"strategy_runs">
    strategyId: Id<"strategies">
}): BufferedAgentTranscriptLogger {
    let buffer: QueuedAgentLogEntry[] = []
    let persistedAgentLogs: AgentLogMemoryEntry[] = []
    let totalLogged = 0
    let flushChain: Promise<void> = Promise.resolve()
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const clearFlushTimer = (): void => {
        if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = undefined
        }
    }

    const scheduleFlushTimer = (): void => {
        clearFlushTimer()
        const oldest = buffer[0]
        if (!oldest) {
            return
        }

        const delayMs = Math.max(0, AGENT_TRANSCRIPT_FLUSH_AGE_MS - (Date.now() - oldest.queuedAt))
        flushTimer = setTimeout(() => {
            void loggerApi.flush().catch((error) => {
                args.logger.error("Agent transcript write failed", {
                    runId: args.runId,
                    strategyId: args.strategyId,
                    error: error instanceof Error ? error.message : String(error),
                })
            })
        }, delayMs)
    }

    const flushNow = async (): Promise<void> => {
        if (buffer.length === 0) {
            clearFlushTimer()
            return
        }

        clearFlushTimer()

        while (buffer.length > 0) {
            const entries = buffer.slice(0, AGENT_TRANSCRIPT_BATCH_SIZE)
            buffer = buffer.slice(AGENT_TRANSCRIPT_BATCH_SIZE)

            try {
                const persisted = await args.backend.logBatch(entries.map(stripQueuedAt))
                persistedAgentLogs = [...persistedAgentLogs, ...persisted]
            } catch (error) {
                buffer = [...entries, ...buffer]
                scheduleFlushTimer()
                throw error
            }
        }

        scheduleFlushTimer()
    }

    const loggerApi: BufferedAgentTranscriptLogger = {
        log: async (
            runId,
            strategyId,
            sequence,
            role,
            content,
            toolName,
            toolInput,
            toolOutput,
            toolCalls
        ) => {
            totalLogged++
            buffer.push({
                runId,
                strategyId,
                sequence,
                role,
                content,
                toolName,
                toolInput,
                toolOutput,
                toolCalls,
                queuedAt: Date.now(),
            })
            scheduleFlushTimer()

            if (buffer.length >= AGENT_TRANSCRIPT_BATCH_SIZE) {
                await loggerApi.flush()
            }
        },
        flush: async () => {
            const flush = flushChain.then(flushNow)
            flushChain = flush.catch(() => undefined)
            await flush
        },
        dispose: () => {
            clearFlushTimer()
        },
        getPersistedAgentLogs: () => [...persistedAgentLogs],
        getTranscriptMessages: () => [
            ...persistedAgentLogs.map(toTranscriptMessage),
            ...buffer.map(toTranscriptMessage),
        ].sort((left, right) => left.sequence - right.sequence),
        hasCompletePersistedTranscript: () => buffer.length === 0 && persistedAgentLogs.length === totalLogged,
    }

    return loggerApi
}

function stripQueuedAt(entry: QueuedAgentLogEntry): AgentLogEntryInput {
    return {
        runId: entry.runId,
        strategyId: entry.strategyId,
        sequence: entry.sequence,
        role: entry.role,
        content: entry.content,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        toolOutput: entry.toolOutput,
        toolCalls: entry.toolCalls,
    }
}

function toTranscriptMessage(entry: AgentLogEntryInput | AgentLogMemoryEntry): AgentRunTranscriptMessage {
    return {
        sequence: entry.sequence,
        role: entry.role,
        content: entry.content,
    }
}

async function flushAgentTranscriptForRun(
    agentTranscript: BufferedAgentTranscriptLogger,
    runLogger: Logger,
    runId: Id<"strategy_runs">,
    strategyId: Id<"strategies">
): Promise<void> {
    try {
        await agentTranscript.flush()
    } catch (error) {
        runLogger.error("Agent transcript write failed", {
            runId,
            strategyId,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

function resolveAgentLogsForOperationalMemoryRefresh(
    agentTranscript: BufferedAgentTranscriptLogger,
    runId: Id<"strategy_runs">,
    strategyId: Id<"strategies">,
    app: VenueApp
): AgentLogMemoryEntry[] | undefined {
    if (!agentTranscript.hasCompletePersistedTranscript()) {
        logger.info("Strategy operational memory refresh fell back to DB agent log read", {
            runId,
            strategyId,
            app,
            reason: "transcript_not_fully_persisted",
        })
        return undefined
    }

    const agentLogs = agentTranscript.getPersistedAgentLogs()
    const payloadBytes = new TextEncoder().encode(JSON.stringify(agentLogs)).length
    if (payloadBytes >= OPERATIONAL_MEMORY_AGENT_LOG_PAYLOAD_LIMIT_BYTES) {
        logger.info("Strategy operational memory refresh fell back to DB agent log read", {
            runId,
            strategyId,
            app,
            reason: "payload_exceeds_limit",
            payloadBytes,
            limitBytes: OPERATIONAL_MEMORY_AGENT_LOG_PAYLOAD_LIMIT_BYTES,
        })
        return undefined
    }

    return agentLogs
}

function buildFailureRunDiagnostics(
    llmConfig: StrategyLlmConfig,
    systemContextDigest?: RunSystemContextDigest,
    toolManifest: ToolManifestEntry[] = [],
    mcpToolDiagnostics: RunDiagnostics["mcpToolDiagnostics"] = [],
    toolCallCount?: number
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
    if (toolCallCount !== undefined) {
        diagnostics.toolCallCount = toolCallCount
    }
    diagnostics.toolManifest = toolManifest

    return diagnostics
}
