import {
    ToolPool,
    ToolRegistry,
    createAlpacaGetOptionsChainTool,
    createAlpacaGetQuoteTool,
    createOKXGetMarketPriceTool,
    createOKXGetOrderBookTool,
    createOKXProposeAdjustmentTool,
    createOKXProposeCloseTool,
    createOKXProposeOrderTool,
    createCancelOrderTool,
    createGetAccountTool,
    createGetOrderStatusTool,
    createGetPositionsTool,
    getToolCategory,
    createMT5ProposeCloseTool,
    createMT5GetSymbolInfoTool,
    createMT5ModifyOrderTool,
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
    createInstrumentConflictValidator,
    createStrategySafetyValidator,
    createKillSwitchGuardedVenue as createRuntimeKillSwitchGuardedVenue,
    buildRunSystemContextDigest,
    formatRunSystemContextDigestLines,
    filterPositionsByOwnershipScope,
    filterWorkingOrdersByOwnershipScope,
    okxPolicySchema,
    getNextCronFireMs,
    mt5PolicySchema,
    parseSummaryMetadata,
    sanitizeRunSummary,
    computeRecentTradeDigest,
    isDryRunAccountLedgerPosition,
    readConfiguredStrategySafetyPolicy,
    resolveDryRunAccountState,
    resolveRuntimeStrategySafetyPolicy,
    resolveStrategyAccountState,
    validatePolicy,
    withTimeout,
    type Logger,
    type Scheduler,
    type AccountState,
    type Position,
    type RunSystemContextDigest,
    type VenueAdapter,
    type StrategyRiskState,
    type WorkingOrder,
} from "@valiq-trading/core"
import { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import { OKXVenueAdapter } from "@valiq-trading/okx"
import { MT5VenueAdapter } from "@valiq-trading/mt5"
import { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { Id, RunTrigger } from "@valiq-trading/convex"
import type { VenueApp, VenuePlugin } from "./types"
import { getCronStartDelayMs } from "./schedule-stagger"
import type { SyncStrategyEntry } from "./state"

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
import { reconcilePendingOrdersForRun } from "./pending-orders"
import { findRemainingOwnedWorkingOrdersAfterSessionFlat } from "./session-flat-assertions"

const PRE_RUN_HOOK_TIMEOUT_MS = 90_000
const POST_RUN_HOOK_TIMEOUT_MS = 90_000
const STRATEGY_RUN_TIMEOUT_MS = 12 * 60 * 1000
const EXTRA_TOOL_CATEGORIES: Record<string, ToolCategory> = {
    query_valiq_research: "research",
    query_valiq_data: "research",
    get_breaking_news: "research",
    search_markets: "research",
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
    const checker = killSwitchCheckers[app]
    if (!checker) return false
    return await checker(context)
}

function createKillSwitchGuardedVenue(
    venue: VenueAdapter,
    app: VenueApp,
    strategyId: string
): VenueAdapter {
    const checker = killSwitchCheckers[app]
    if (!checker) return venue
    return createRuntimeKillSwitchGuardedVenue(
        venue,
        strategyId,
        checker
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

function readPolicyReasoningConfig(policy: Record<string, unknown>): { effort: "low" | "medium" | "high"; exclude: boolean } | undefined {
    const reasoning = readRecord(policy.reasoning)
    const effort = reasoning?.effort

    if (effort !== "low" && effort !== "medium" && effort !== "high") {
        return undefined
    }

    return {
        effort,
        exclude: reasoning?.exclude !== false,
    }
}

function buildPromptBlockedIdentifiers(args: {
    allPositions: Position[]
    ownedPositions: Position[]
    allWorkingOrders: WorkingOrder[]
    ownedWorkingOrders: WorkingOrder[]
    policy: Record<string, unknown>
}): string[] {
    const ownedPositionKeys = new Set(args.ownedPositions.map(buildPositionPromptKey))
    const ownedOrderIds = new Set(args.ownedWorkingOrders.map((order) => order.orderId))
    const expectedExternal = readExpectedExternalIdentifiers(args.policy)
    const blocked = new Set<string>(expectedExternal)

    for (const position of args.allPositions) {
        if (ownedPositionKeys.has(buildPositionPromptKey(position)) && !matchesExpectedExternal(position, expectedExternal)) {
            continue
        }

        addPositionIdentifiers(blocked, position)
    }

    for (const order of args.allWorkingOrders) {
        if (ownedOrderIds.has(order.orderId) && !matchesExpectedExternal(order, expectedExternal)) {
            continue
        }

        addWorkingOrderIdentifiers(blocked, order)
    }

    return Array.from(blocked).sort((left, right) => left.localeCompare(right))
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object"
        ? value as Record<string, unknown>
        : undefined
}

function readExpectedExternalIdentifiers(policy: Record<string, unknown>): Set<string> {
    const safety = readRecord(policy.safety)
    const expected = safety?.expectedExternalInstruments
    const identifiers = new Set<string>()

    if (!Array.isArray(expected)) {
        return identifiers
    }

    for (const value of expected) {
        addPromptIdentifier(identifiers, value)
    }

    return identifiers
}

function buildPositionPromptKey(position: Position): string {
    return `${position.instrument}:${position.providerPositionId ?? position.side}`
}

function matchesExpectedExternal(
    value: Position | WorkingOrder,
    expectedExternal: Set<string>
): boolean {
    if (expectedExternal.size === 0) {
        return false
    }

    const identifiers = new Set<string>()
    if ("orderId" in value) {
        addWorkingOrderIdentifiers(identifiers, value)
    } else {
        addPositionIdentifiers(identifiers, value)
    }

    for (const identifier of identifiers) {
        if (expectedExternal.has(identifier)) {
            return true
        }
    }

    return false
}

function addPositionIdentifiers(identifiers: Set<string>, position: Position): void {
    addPromptIdentifier(identifiers, position.instrument)
    addPromptIdentifier(identifiers, position.providerPositionId)
    addMetadataIdentifiers(identifiers, position.metadata)
}

function addWorkingOrderIdentifiers(identifiers: Set<string>, order: WorkingOrder): void {
    addPromptIdentifier(identifiers, order.instrument)
    addPromptIdentifier(identifiers, order.orderId)
    addMetadataIdentifiers(identifiers, order.metadata)
}

function addMetadataIdentifiers(identifiers: Set<string>, metadata: Record<string, unknown> | undefined): void {
    if (!metadata) {
        return
    }

    for (const key of ["tokenId", "conditionId", "market", "marketSlug", "slug", "question", "instrument"]) {
        addPromptIdentifier(identifiers, metadata[key])
    }
}

function addPromptIdentifier(identifiers: Set<string>, value: unknown): void {
    if (typeof value !== "string") {
        return
    }

    const normalized = value.trim()
    if (normalized.length < 4) {
        return
    }

    identifiers.add(normalized)
}

function mergePendingOrderBlockedInstrumentsIntoRiskState(
    riskState: StrategyRiskState,
    blockedInstruments: string[]
): StrategyRiskState {
    if (blockedInstruments.length === 0) {
        return riskState
    }

    const existingBlocked = new Set(riskState.blockedInstruments)
    const mergedBlockedInstruments = Array.from(
        new Set([...riskState.blockedInstruments, ...blockedInstruments])
    ).sort((left, right) => left.localeCompare(right))
    const newBlockedCount = blockedInstruments.filter((instrument) => !existingBlocked.has(instrument)).length

    return {
        ...riskState,
        safetyState: riskState.safetyState === "healthy"
            ? "execution_degraded"
            : riskState.safetyState,
        blockedInstruments: mergedBlockedInstruments,
        unresolvedExecutionFaultCount: riskState.unresolvedExecutionFaultCount + newBlockedCount,
    }
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

    runLogger.error("Unknown extra tool category", {
        app,
        tool: tool.name,
    })

    throw new Error(`Unknown extra tool category for ${tool.name}`)
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

function buildRunDiagnostics(result: {
    usage: {
        promptTokens: number
        completionTokens: number
        reasoningTokens: number
        cost: number
        responseIds: string[]
    }
    opportunityCoverage: {
        researched: number
        qualified: number
        rejectedByModel: number
        rejectedByRisk: number
        submitted: number
        filled: number
        closed: number
        realizedPnl: number
    }
    degradedResearch?: {
        active: boolean
        reasons: string[]
        toolFailureCount: number
        retryCount: number
        decisionUnderDegradedContext: boolean
    }
}, systemContextDigest?: RunSystemContextDigest): {
    degradedResearch?: boolean
    degradedReason?: string
    toolFailureCount?: number
    toolRetryCount?: number
    decisionUnderDegradedContext?: boolean
    promptTokens?: number
    completionTokens?: number
    reasoningTokens?: number
    llmCost?: number
    openRouterResponseIds?: string[]
    opportunityResearched?: number
    opportunityQualified?: number
    opportunityRejectedByModel?: number
    opportunityRejectedByRisk?: number
    opportunitySubmitted?: number
    opportunityFilled?: number
    opportunityClosed?: number
    opportunityRealizedPnl?: number
    systemContextDigest?: RunSystemContextDigest
} | undefined {
    const diagnostics: {
        degradedResearch?: boolean
        degradedReason?: string
        toolFailureCount?: number
        toolRetryCount?: number
        decisionUnderDegradedContext?: boolean
        promptTokens?: number
        completionTokens?: number
        reasoningTokens?: number
        llmCost?: number
        openRouterResponseIds?: string[]
        opportunityResearched?: number
        opportunityQualified?: number
        opportunityRejectedByModel?: number
        opportunityRejectedByRisk?: number
        opportunitySubmitted?: number
        opportunityFilled?: number
        opportunityClosed?: number
        opportunityRealizedPnl?: number
        systemContextDigest?: RunSystemContextDigest
    } = {}

    diagnostics.promptTokens = result.usage.promptTokens
    diagnostics.completionTokens = result.usage.completionTokens
    diagnostics.reasoningTokens = result.usage.reasoningTokens
    diagnostics.llmCost = result.usage.cost
    diagnostics.openRouterResponseIds = result.usage.responseIds
    diagnostics.opportunityResearched = result.opportunityCoverage.researched
    diagnostics.opportunityQualified = result.opportunityCoverage.qualified
    diagnostics.opportunityRejectedByModel = result.opportunityCoverage.rejectedByModel
    diagnostics.opportunityRejectedByRisk = result.opportunityCoverage.rejectedByRisk
    diagnostics.opportunitySubmitted = result.opportunityCoverage.submitted
    diagnostics.opportunityFilled = result.opportunityCoverage.filled
    diagnostics.opportunityClosed = result.opportunityCoverage.closed
    diagnostics.opportunityRealizedPnl = result.opportunityCoverage.realizedPnl

    if (result.degradedResearch) {
        diagnostics.degradedResearch = result.degradedResearch.active
        diagnostics.degradedReason = result.degradedResearch.reasons.join("; ")
        diagnostics.toolFailureCount = result.degradedResearch.toolFailureCount
        diagnostics.toolRetryCount = result.degradedResearch.retryCount
        diagnostics.decisionUnderDegradedContext = result.degradedResearch.decisionUnderDegradedContext
    }

    if (systemContextDigest) {
        diagnostics.systemContextDigest = systemContextDigest
    }

    return Object.keys(diagnostics).length > 0
        ? diagnostics
        : undefined
}

async function resolveRuntimeSafetyPolicyForRun(args: {
    policy: Record<string, unknown>
    venue: VenueAdapter
    latestStoredPositions?: Position[]
    accountState?: AccountState
}): Promise<ReturnType<typeof resolveRuntimeStrategySafetyPolicy>> {
    const configuredSafety = readConfiguredStrategySafetyPolicy(args.policy)
    const requiresBalance = configuredSafety.maxDrawdownDay !== undefined ||
        configuredSafety.maxDrawdownWeek !== undefined

    if (!requiresBalance) {
        return resolveRuntimeStrategySafetyPolicy({
            policy: configuredSafety,
        })
    }

    if (args.accountState) {
        return resolveRuntimeStrategySafetyPolicy({
            policy: configuredSafety,
            accountBalance: args.accountState.balance,
        })
    }

    if (Boolean(args.policy.dryRun)) {
        if (args.latestStoredPositions === undefined) {
            throw new Error("Dry-run safety policy resolution requires stored positions or current account state")
        }

        const dryRunAccountState = resolveDryRunAccountState({
            policy: args.policy,
            positions: args.latestStoredPositions,
        })

        return resolveRuntimeStrategySafetyPolicy({
            policy: configuredSafety,
            accountBalance: dryRunAccountState.balance,
        })
    }

    throw new Error("Live safety policy resolution requires strategy-scoped account state")
}

function registerCanonicalTool(
    toolPool: ToolPool,
    registration: {
        name: string
        compatibleVenues: readonly VenueApp[]
        create: () => ToolDefinition | ToolDefinition[] | null | undefined
    }
): void {
    toolPool.registerFactory({
        ...registration,
        category: getToolCategory(registration.name),
    })
}

function buildToolPool(config: {
    app: VenueApp
    strategyId: string
    venue: VenueAdapter
    pipeline: ExecutionPipeline
    policy: Record<string, unknown>
    extraTools: ToolDefinition[]
    isCallback: boolean
    runLogger: Logger
}): ToolPool {
    const {
        app,
        strategyId,
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

    registerCanonicalTool(toolPool, {
        name: "get_positions",
        compatibleVenues: VENUE_APPS,
        create: () => createGetPositionsTool(pipeline),
    })
    registerCanonicalTool(toolPool, {
        name: "get_account",
        compatibleVenues: VENUE_APPS,
        create: () => createGetAccountTool(pipeline),
    })
    registerCanonicalTool(toolPool, {
        name: "get_order_status",
        compatibleVenues: VENUE_APPS,
        create: () => createGetOrderStatusTool(pipeline),
    })
    registerCanonicalTool(toolPool, {
        name: "cancel_order",
        compatibleVenues: VENUE_APPS,
        create: () => createCancelOrderTool(pipeline),
    })
    registerCanonicalTool(toolPool, {
        name: "wait_for_order_update",
        compatibleVenues: VENUE_APPS,
        create: () => createWaitForOrderUpdateTool(pipeline),
    })
    registerCanonicalTool(toolPool, {
        name: "modify_order",
        compatibleVenues: ["alpaca-options", "mt5", "polymarket"],
        create: () => {
            if (app === "alpaca-options") {
                return createModifyOrderTool(pipeline, { mode: "alpaca-options" })
            }

            if (app === "mt5") {
                return createMT5ModifyOrderTool(pipeline)
            }

            if (app === "polymarket") {
                return createModifyOrderTool(pipeline)
            }

            return null
        },
    })
    registerCanonicalTool(toolPool, {
        name: "get_symbol_info",
        compatibleVenues: ["mt5"],
        create: () => {
            if (!(venue instanceof MT5VenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_symbol_info", "MT5VenueAdapter", venue)
                return null
            }

            return createMT5GetSymbolInfoTool(venue)
        },
    })
    registerCanonicalTool(toolPool, {
        name: "propose_order",
        compatibleVenues: VENUE_APPS,
        create: () => {
            if (app === "mt5") {
                if (!(venue instanceof MT5VenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_order", "MT5VenueAdapter", venue)
                    return null
                }

                return createMT5ProposeOrderTool(pipeline, venue, mt5PolicySchema.parse(policy))
            }

            if (app === "alpaca-options") {
                if (!(venue instanceof AlpacaOptionsVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_order", "AlpacaOptionsVenueAdapter", venue)
                    return null
                }

                return createProposeOrderTool(pipeline, {
                    mode: "alpaca-options",
                })
            }

            if (app === "polymarket") {
                if (!(venue instanceof PolymarketVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_order", "PolymarketVenueAdapter", venue)
                    return null
                }

                return createPolymarketProposeOrderTool(pipeline, venue)
            }

            if (app === "okx-swap") {
                if (!(venue instanceof OKXVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_order", "OKXVenueAdapter", venue)
                    return null
                }

                return createOKXProposeOrderTool(
                    pipeline,
                    venue,
                    okxPolicySchema.parse(policy),
                    {
                        onExecutionSafetyFault: async ({ instrument, category, message, providerPayload }) => {
                            await backend.recordExecutionSafetyFault({
                                strategyId: strategyId as Id<"strategies">,
                                app: "okx-swap",
                                instrument,
                                category,
                                message,
                                providerPayload,
                                blocked: true,
                            })
                            runLogger.error("Recorded execution safety fault", {
                                strategyId,
                                app,
                                instrument,
                                category,
                                message,
                            })
                        },
                        onExecutionSafetyRecovered: async ({ instrument, resolutionNote }) => {
                            const result = await backend.resolveExecutionSafetyFaults({
                                strategyId: strategyId as Id<"strategies">,
                                instrument,
                                resolutionNote,
                            })
                            if (result.resolved > 0) {
                                runLogger.info("Cleared execution safety faults", {
                                    strategyId,
                                    app,
                                    instrument,
                                    resolved: result.resolved,
                                })
                            }
                        },
                    }
                )
            }

            return null
        },
    })
    registerCanonicalTool(toolPool, {
        name: "propose_adjustment",
        compatibleVenues: VENUE_APPS,
        create: () => {
            if (app === "mt5") {
                if (!(venue instanceof MT5VenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_adjustment", "MT5VenueAdapter", venue)
                    return null
                }

                return createMT5ProposeAdjustmentTool(
                    pipeline,
                    venue,
                    mt5PolicySchema.parse(policy)
                )
            }

            if (app === "alpaca-options") {
                return createProposeAdjustmentTool(pipeline)
            }

            if (app === "polymarket") {
                if (!(venue instanceof PolymarketVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_adjustment", "PolymarketVenueAdapter", venue)
                    return null
                }

                return createPolymarketProposeAdjustmentTool(pipeline, venue)
            }

            if (app === "okx-swap") {
                if (!(venue instanceof OKXVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_adjustment", "OKXVenueAdapter", venue)
                    return null
                }

                const parsedPolicy = okxPolicySchema.parse(policy)
                return createOKXProposeAdjustmentTool(pipeline, venue, {
                    dryRun: parsedPolicy.dryRun,
                    requireTakeProfit: parsedPolicy.requireTakeProfit,
                    onExecutionSafetyFault: async ({ instrument, category, message, providerPayload }) => {
                        await backend.recordExecutionSafetyFault({
                            strategyId: strategyId as Id<"strategies">,
                            app: "okx-swap",
                            instrument,
                            category,
                            message,
                            providerPayload,
                            blocked: true,
                        })
                    },
                    onExecutionSafetyRecovered: async ({ instrument, resolutionNote }) => {
                        await backend.resolveExecutionSafetyFaults({
                            strategyId: strategyId as Id<"strategies">,
                            instrument,
                            resolutionNote,
                        })
                    },
                })
            }

            return null
        },
    })
    registerCanonicalTool(toolPool, {
        name: "propose_close",
        compatibleVenues: VENUE_APPS,
        create: () => {
            if (app === "mt5") {
                if (!(venue instanceof MT5VenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_close", "MT5VenueAdapter", venue)
                    return null
                }

                return createMT5ProposeCloseTool(pipeline, venue)
            }

            if (app === "alpaca-options") {
                return createProposeCloseTool(pipeline)
            }

            if (app === "polymarket") {
                if (!(venue instanceof PolymarketVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_close", "PolymarketVenueAdapter", venue)
                    return null
                }

                return createPolymarketProposeCloseTool(pipeline, venue)
            }

            if (app === "okx-swap") {
                if (!(venue instanceof OKXVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "propose_close", "OKXVenueAdapter", venue)
                    return null
                }

                return createOKXProposeCloseTool(pipeline, venue)
            }

            return null
        },
    })
    registerCanonicalTool(toolPool, {
        name: "get_options_chain",
        compatibleVenues: ["alpaca-options"],
        create: () => {
            if (!(venue instanceof AlpacaOptionsVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_options_chain", "AlpacaOptionsVenueAdapter", venue)
                return null
            }

            return createAlpacaGetOptionsChainTool(venue)
        },
    })
    registerCanonicalTool(toolPool, {
        name: "get_quote",
        compatibleVenues: ["alpaca-options"],
        create: () => {
            if (!(venue instanceof AlpacaOptionsVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "get_quote", "AlpacaOptionsVenueAdapter", venue)
                return null
            }

            return createAlpacaGetQuoteTool(venue)
        },
    })
    registerCanonicalTool(toolPool, {
        name: "get_market_price",
        compatibleVenues: ["polymarket", "okx-swap"],
        create: () => {
            if (app === "polymarket") {
                if (!(venue instanceof PolymarketVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "get_market_price", "PolymarketVenueAdapter", venue)
                    return null
                }

                return createPolymarketGetMarketPriceTool(venue)
            }

            if (app === "okx-swap") {
                if (!(venue instanceof OKXVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "get_market_price", "OKXVenueAdapter", venue)
                    return null
                }

                return createOKXGetMarketPriceTool(venue)
            }

            return null
        },
    })
    registerCanonicalTool(toolPool, {
        name: "get_order_book",
        compatibleVenues: ["polymarket", "okx-swap"],
        create: () => {
            if (app === "polymarket") {
                if (!(venue instanceof PolymarketVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "get_order_book", "PolymarketVenueAdapter", venue)
                    return null
                }

                return createPolymarketGetOrderBookTool(venue)
            }

            if (app === "okx-swap") {
                if (!(venue instanceof OKXVenueAdapter)) {
                    logVenueToolMismatch(runLogger, app, "get_order_book", "OKXVenueAdapter", venue)
                    return null
                }

                return createOKXGetOrderBookTool(venue)
            }

            return null
        },
    })
    registerCanonicalTool(toolPool, {
        name: "search_markets",
        compatibleVenues: ["polymarket"],
        create: () => {
            if (!(venue instanceof PolymarketVenueAdapter)) {
                logVenueToolMismatch(runLogger, app, "search_markets", "PolymarketVenueAdapter", venue)
                return null
            }

            return createPolymarketSearchMarketsTool(venue)
        },
    })
    registerCanonicalTool(toolPool, {
        name: "web_search",
        compatibleVenues: ["polymarket"],
        create: () => withCallBudget(
            createWebSearchTool(searchProvider),
            isCallback ? 2 : 5
        ),
    })
    registerCanonicalTool(toolPool, {
        name: "web_fetch",
        compatibleVenues: ["polymarket"],
        create: () => withCallBudget(
            createWebFetchTool(),
            isCallback ? 1 : 3
        ),
    })

    return toolPool
}

export async function registerStrategyWithScheduler(
    scheduler: Scheduler,
    app: VenueApp,
    strategy: StoredStrategy
): Promise<void> {
    const plugin = plugins[app]
    if (!plugin) {
        logger.warn("No plugin registered for app, skipping strategy", { app, strategyId: strategy._id })
        return
    }
    const runtimeEntry = await resolveStrategyRuntimeState(app, strategy)
    upsertSyncStrategyEntry(app, runtimeEntry)

    scheduler.register({
        strategyId: strategy._id,
        scheduleType: "cron",
        cronExpression: runtimeEntry.strategy.schedule,
        handler: async () => {
            const latestStrategy = await backend.getStrategyById(strategy._id)

            if (!latestStrategy) {
                logger.info("Skipping scheduled run for deleted strategy", {
                    strategyId: strategy._id,
                    app,
                })
                pendingManualTriggers.delete(strategy._id)
                return
            }

            if (!latestStrategy.enabled) {
                logger.info("Skipping scheduled run for disabled strategy", {
                    strategyId: strategy._id,
                    app,
                })
                pendingManualTriggers.delete(strategy._id)
                return
            }

            const latestRuntimeEntry = await resolveStrategyRuntimeState(app, latestStrategy)
            upsertSyncStrategyEntry(app, latestRuntimeEntry)

            const isManual = pendingManualTriggers.delete(strategy._id)
            const trigger = isManual ? "manual" : "cron"
            const runAt = new Date()
            const startDelayMs = trigger === "cron"
                ? getCronStartDelayMs(app, latestRuntimeEntry.strategy, syncStrategies[app] ?? [], runAt)
                : 0

            if (startDelayMs > 0) {
                logger.info("Delaying cron start to stagger same-minute strategy runs", {
                    strategyId: latestRuntimeEntry.strategy._id,
                    app,
                    delayMs: startDelayMs,
                    schedule: latestRuntimeEntry.strategy.schedule,
                })
                await sleep(startDelayMs)
            }

            await runStrategy(
                app,
                plugin,
                latestRuntimeEntry.strategy,
                latestRuntimeEntry.policy,
                latestRuntimeEntry.secrets,
                scheduler,
                trigger
            )
        },
    })
}

export async function resolveStrategyRuntimeState(
    app: VenueApp,
    strategy: StoredStrategy
): Promise<SyncStrategyEntry> {
    const plugin = plugins[app]
    if (!plugin) {
        throw new Error(`No plugin registered for ${app}`)
    }

    const policy = validatePolicy(app, strategy.policy)
    const additionalSecretKeys = plugin.resolveAdditionalSecretKeys?.(policy) ?? []
    const additionalSecrets =
        additionalSecretKeys.length > 0
            ? await backend.resolveSecrets(additionalSecretKeys)
            : {}

    return {
        strategy,
        policy,
        secrets: {
            ...resolvedSecrets,
            ...additionalSecrets,
        },
    }
}

export function upsertSyncStrategyEntry(
    app: VenueApp,
    entry: SyncStrategyEntry
): void {
    syncStrategies[app] ??= []
    const existingIndex = syncStrategies[app].findIndex(
        (candidate) => candidate.strategy._id === entry.strategy._id
    )

    if (existingIndex === -1) {
        syncStrategies[app].push(entry)
        return
    }

    syncStrategies[app][existingIndex] = entry
}

export function syncStrategyEntryChanged(
    current: SyncStrategyEntry,
    next: SyncStrategyEntry
): boolean {
    return stableStringify({
        strategy: current.strategy,
        policy: current.policy,
        secrets: current.secrets,
    }) !== stableStringify({
        strategy: next.strategy,
        policy: next.policy,
        secrets: next.secrets,
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
        initialPositions,
        initialWorkingOrders,
        initialProviderAccountState,
    ] = await Promise.all([
        backend.getStrategyOwnershipScope(strategy._id),
        backend.getAllOwnedInstrumentsByApp(app),
        storedPositionsPromise,
        isDryRun
            ? storedPositionsPromise
            : venue.getPositions(),
        !isDryRun && venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
        isDryRun
            ? Promise.resolve(undefined)
            : venue.getAccountState(),
    ])
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
    let runtimeContextLines: string[] | undefined

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
            }
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

    let pipeline: ExecutionPipeline | undefined
    let runSystemContextDigest: RunSystemContextDigest | undefined
    let latestStoredPositions: Position[] | undefined
    let currentAccountState: AccountState | undefined

    try {
        latestStoredPositions = storedPositions

        const conflictMap = new Map<string, string>()
        for (const entry of allOwnedInstruments) {
            if (entry.strategyId !== strategy._id) {
                conflictMap.set(entry.instrument, entry.strategyId)
            }
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
        const pluginValidators = plugin.getRiskValidators()
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
            riskValidators: buildRiskValidators(runRiskState),
            logger: runLogger,
            tradeEventLogger: backend,
            orderPersistence,
            priceVerification: {
                failClosedOnVerificationError: app === "polymarket",
            },
            runId,
            strategyId: strategy._id,
            ownedInstruments,
            strategyRealizedPnl: runRiskState.day.realizedPnl,
        })
        const activePipeline = pipeline

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

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => sortJsonValue(entry))
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, sortJsonValue(entry)])
        )
    }

    return value
}
