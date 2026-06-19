import {
    ToolRegistry,
    withMcpToolCallBudget,
    type McpToolDiagnostic,
    type ToolBinding,
} from "@valiq-trading/agent"
import { createConvexOrderPersistenceAdapter } from "@valiq-trading/convex"
import type { Id, RunTrigger, StoredStrategy, StrategyMcpToolWhitelist } from "@valiq-trading/convex"
import {
    ExecutionPipeline,
    buildRunSystemContextDigest,
    computeRecentTradeDigest,
    createInstrumentConflictValidator,
    createStrategySafetyValidator,
    filterPositionsByOwnershipScope,
    filterWorkingOrdersByOwnershipScope,
    formatRunSystemContextDigestLines,
    isDryRunAccountLedgerPosition,
    resolveDryRunAccountState,
    resolveStrategyAccountState,
    type AccountState,
    type Logger,
    type OrderPersistenceAdapter,
    type Position,
    type ProviderOwnershipScope,
    type RuntimeStrategySafetyPolicy,
    type RunSystemContextDigest,
    type StrategyRiskState,
    type StrategyRunContext,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import { buildToolPool } from "./scheduler-tool-pool"
import {
    buildPromptBlockedIdentifiers,
    mergeRuntimeContextLines,
} from "./scheduler-context"
import {
    backend,
    backendServiceToken,
    convexUrl,
} from "./state"
import {
    createKillSwitchGuardedVenue,
    mergePendingOrderBlockedInstrumentsIntoRiskState,
    resolveRuntimeSafetyPolicyForRun,
} from "./scheduler-run-support"
import type { VenueApp, VenuePlugin } from "./types"
import { reconcilePendingOrdersForRun } from "./pending-orders"
import { runProviderAccountOperation } from "./provider-account-coordinator"

interface CreateScheduledRunRuntimeArgs {
    app: VenueApp
    plugin: VenuePlugin
    strategy: StoredStrategy
    policy: Record<string, unknown>
    strategySecrets: Record<string, string | null>
    runId: Id<"strategy_runs">
    runLogger: Logger
}

export interface ScheduledRunRuntime {
    app: VenueApp
    plugin: VenuePlugin
    strategy: StoredStrategy
    policy: Record<string, unknown>
    strategySecrets: Record<string, string | null>
    mcpToolWhitelist: StrategyMcpToolWhitelist | null
    runId: Id<"strategy_runs">
    runLogger: Logger
    venue: VenueAdapter
    pipeline: ExecutionPipeline
    orderPersistence: OrderPersistenceAdapter
    isDryRun: boolean
    storedPositions?: Position[]
    ownershipScope: ProviderOwnershipScope
    ownedInstruments: Set<string>
    initialPositions: Position[]
    initialWorkingOrders: WorkingOrder[]
    initialOwnedPositions: Position[]
    initialOwnedWorkingOrders: WorkingOrder[]
    initialStrategyAccountState: AccountState
    applyRiskState(riskState: StrategyRiskState): void
    cleanup(): void
}

export interface ScheduledRunRiskSnapshot {
    safetyPolicy: RuntimeStrategySafetyPolicy
    riskState: StrategyRiskState
}

export interface PreparedScheduledRunAgentTurn {
    context: StrategyRunContext
    tools: ToolRegistry
    runSystemContextDigest: RunSystemContextDigest
    riskState: StrategyRiskState
    runtimeContextLines?: string[]
    toolManifest: ReturnType<ToolRegistry["getManifest"]>
    mcpToolDiagnostics: McpToolDiagnostic[]
}

export async function createScheduledRunRuntime(
    args: CreateScheduledRunRuntimeArgs
): Promise<ScheduledRunRuntime> {
    const {
        app,
        plugin,
        strategy,
        policy,
        strategySecrets,
        runId,
        runLogger,
    } = args
    const venue = plugin.createVenueAdapter(policy, strategySecrets)
    const isDryRun = Boolean(policy.dryRun)
    const storedPositionsPromise = isDryRun
        ? backend.getLatestPositions(strategy._id)
        : Promise.resolve(undefined)
    const [
        ownershipScopeRow,
        allOwnedInstruments,
        storedPositions,
        mcpToolWhitelist,
    ] = await Promise.all([
        backend.getStrategyOwnershipScope(strategy._id),
        backend.getAllOwnedInstrumentsByApp(app, strategy.accountId),
        storedPositionsPromise,
        backend.getStrategyMcpToolWhitelist(strategy._id),
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
        ? initialPositions.filter((position) => !isDryRunAccountLedgerPosition(position))
        : filterPositionsByOwnershipScope(initialPositions, ownershipScope)
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

    const conflictMap = new Map<string, string>()
    for (const owned of allOwnedInstruments) {
        if (owned.strategyId !== strategy._id) {
            conflictMap.set(owned.instrument, owned.strategyId)
        }
    }

    const pluginValidators = plugin.getRiskValidators()
    const guardedVenue = createKillSwitchGuardedVenue(venue, app, strategy._id)
    const runOrderLifecycleOperation = async <T>(
        operation: string,
        run: () => Promise<T>
    ): Promise<T> => {
        const result = await runProviderAccountOperation({
            app,
            accountId: strategy.accountId,
            source: "order_lifecycle",
            label: `order lifecycle ${operation}`,
            logger: runLogger,
        }, run)
        if (result.status === "skipped") {
            throw new Error(result.reason)
        }

        return result.value
    }
    const orderPersistence = createConvexOrderPersistenceAdapter({
        url: convexUrl,
        machineAuth: {
            serviceToken: backendServiceToken,
        },
        orderLookupScope: {
            app,
            accountId: strategy.accountId,
            strategyId: strategy._id,
        },
        mutationLock: runOrderLifecycleOperation,
    })
    const pipeline = new ExecutionPipeline({
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
        accountId: strategy.accountId,
        ownedInstruments,
        ownershipScope,
        strategyRealizedPnl: 0,
        orderOperationLock: runOrderLifecycleOperation,
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

    let cleanedUp = false
    const applyRiskState = (riskState: StrategyRiskState) => {
        const safetyValidator = createStrategySafetyValidator({
            safetyState: riskState.safetyState,
            blockedInstruments: new Set(riskState.blockedInstruments),
            reason: riskState.cooldown.active
                ? `Strategy cooldown active (${riskState.cooldown.reason ?? "risk"})`
                : undefined,
            blockedInstrumentReason: riskState.cooldown.active
                ? `Instrument is blocked because strategy cooldown is active (${riskState.cooldown.reason ?? "risk"}). Only risk-reducing actions are allowed until the cooldown expires.`
                : undefined,
        })
        pipeline.setRiskValidators(
            conflictMap.size > 0
                ? [safetyValidator, ...pluginValidators, createInstrumentConflictValidator(conflictMap)]
                : [safetyValidator, ...pluginValidators]
        )
        pipeline.setStrategyRealizedPnl(riskState.day.realizedPnl)
    }

    return {
        app,
        plugin,
        strategy,
        policy,
        strategySecrets,
        mcpToolWhitelist,
        runId,
        runLogger,
        venue,
        pipeline,
        orderPersistence,
        isDryRun,
        storedPositions,
        ownershipScope,
        ownedInstruments,
        initialPositions,
        initialWorkingOrders,
        initialOwnedPositions,
        initialOwnedWorkingOrders,
        initialStrategyAccountState,
        applyRiskState,
        cleanup: () => {
            if (cleanedUp) {
                return
            }

            cleanedUp = true
            pipeline.stopAllTracking()
        },
    }
}

export async function resolveScheduledRunRiskSnapshot(
    runtime: ScheduledRunRuntime,
    accountState: AccountState = runtime.initialStrategyAccountState
): Promise<ScheduledRunRiskSnapshot> {
    const safetyPolicy = await resolveRuntimeSafetyPolicyForRun({
        policy: runtime.policy,
        venue: runtime.venue,
        latestStoredPositions: runtime.storedPositions,
        accountState,
    })
    const riskState = await backend.refreshStrategyRiskState({
        strategyId: runtime.strategy._id,
        app: runtime.app,
        policy: safetyPolicy,
    })
    runtime.applyRiskState(riskState)

    return {
        safetyPolicy,
        riskState,
    }
}

export async function prepareScheduledRunAgentTurn(
    runtime: ScheduledRunRuntime,
    args: {
        trigger: RunTrigger
        isCallback: boolean
        safetyPolicy: { strategyTimezone: string }
        riskState: StrategyRiskState
        runtimeContextLines?: string[]
    }
): Promise<PreparedScheduledRunAgentTurn> {
    const {
        app,
        strategy,
        policy,
        strategySecrets,
        mcpToolWhitelist,
        runLogger,
        venue,
        pipeline,
        isDryRun,
        storedPositions,
        ownershipScope,
        initialWorkingOrders,
        initialOwnedWorkingOrders,
        orderPersistence,
    } = runtime
    let runRiskState = args.riskState
    let runtimeContextLines = args.runtimeContextLines
    const mcpToolDiagnostics: McpToolDiagnostic[] = []
    const tools = new ToolRegistry()
    const extraTools = await runtime.plugin.getExtraTools({
        secrets: strategySecrets,
        runLogger,
        mcpToolWhitelist,
        mcpToolDiagnostics,
        mcpToolRegistry: tools,
        mcpToolTransform: (tool) => applyMcpResearchBudget(tool, args.isCallback),
    })
    const budgetedExtraTools = extraTools.map((tool) =>
        applyMcpResearchBudget(tool, args.isCallback)
    )
    const toolPool = buildToolPool({
        app,
        strategyId: strategy._id,
        venue,
        pipeline,
        policy,
        extraTools: budgetedExtraTools,
        isCallback: args.isCallback,
        runLogger,
    })
    for (const tool of toolPool.forVenue(app)) {
        tools.register(tool)
    }

    const {
        pendingOrders,
        runtimeContextLines: pendingOrderRuntimeContext,
        blockedInstruments: pendingOrderBlockedInstruments,
    } = await reconcilePendingOrdersForRun(
        pipeline,
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
        runtime.applyRiskState(runRiskState)
    }

    const timestamp = Date.now()
    const toolManifest = tools.getManifest()
    const [allPositions, operationalMemory, recentOrderHistory] = await Promise.all([
        isDryRun ? Promise.resolve(storedPositions ?? []) : venue.getPositions(),
        backend.getApplicableStrategyOperationalMemory(
            strategy._id,
            app,
            strategy.accountId,
            toolManifest
        ),
        backend.getStrategyOrderHistory(strategy._id, 250),
    ])
    const recentTrades = computeRecentTradeDigest({
        orders: recentOrderHistory,
        timezone: args.safetyPolicy.strategyTimezone,
        timestamp,
    })
    const runSystemContextDigest = buildRunSystemContextDigest({
        generatedAt: timestamp,
        riskState: runRiskState,
        recentTrades,
        pendingOrders,
    })
    runtimeContextLines = mergeRuntimeContextLines(
        runtimeContextLines,
        formatRunSystemContextDigestLines(runSystemContextDigest)
    )

    if (isDryRun) {
        pipeline.seedDryRunPositions(allPositions)
    }

    const positions = isDryRun
        ? pipeline.getDryRunPositions()
        : filterPositionsByOwnershipScope(allPositions, ownershipScope)
    const accountState = await pipeline.getAccountState()
    const context: StrategyRunContext = {
        runId: runtime.runId,
        strategyId: strategy._id,
        app,
        timestamp,
        trigger: args.trigger,
        positions,
        accountState,
        policy,
        context: strategy.context,
        runtimeContextLines,
        schedule: strategy.schedule,
        pendingOrders,
        operationalMemory,
        promptSanitizer: {
            blockedIdentifiers: buildPromptBlockedIdentifiers({
                allPositions,
                ownedPositions: positions,
                allWorkingOrders: initialWorkingOrders,
                ownedWorkingOrders: initialOwnedWorkingOrders,
                policy,
            }),
        },
    }

    return {
        context,
        tools,
        runSystemContextDigest,
        riskState: runRiskState,
        runtimeContextLines,
        toolManifest,
        mcpToolDiagnostics,
    }
}

function applyMcpResearchBudget(tool: ToolBinding, isCallback: boolean): ToolBinding {
    if (tool.contractOwner?.startsWith("mcp:") !== true) {
        return tool
    }

    return withMcpToolCallBudget(tool, isCallback ? 2 : 4)
}
