import {
    ToolPool,
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
    createMT5GetSymbolInfoTool,
    createMT5ModifyOrderTool,
    createMT5ProposeAdjustmentTool,
    createMT5ProposeCloseTool,
    createMT5ProposeOrderTool,
    createModifyOrderTool,
    createPolymarketGetMarketPriceTool,
    createPolymarketGetOrderBookTool,
    createPolymarketProposeAdjustmentTool,
    createPolymarketProposeCloseTool,
    createPolymarketProposeOrderTool,
    createPolymarketSearchMarketsTool,
    createProposeAdjustmentTool,
    createProposeCloseTool,
    createProposeOrderTool,
    createWaitForOrderUpdateTool,
    createWebFetchTool,
    createWebSearchTool,
    getToolCategory,
    PolymarketMarketHandleRegistry,
    withCallBudget,
    type ToolCategory,
    type ToolDefinition,
} from "@valiq-trading/agent"
import type { Id } from "@valiq-trading/convex"
import {
    VENUE_APPS,
    mt5PolicySchema,
    okxPolicySchema,
    type ExecutionPipeline,
    type Logger,
    type VenueAdapter,
} from "@valiq-trading/core"
import { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import { OKXVenueAdapter } from "@valiq-trading/okx"
import { MT5VenueAdapter } from "@valiq-trading/mt5"
import { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { VenueApp } from "./types"
import { backend, searchProvider } from "./state"

const EXTRA_TOOL_CATEGORIES: Record<string, ToolCategory> = {
    query_valiq_research: "research",
    query_valiq_data: "research",
    get_breaking_news: "research",
    search_markets: "research",
}

interface BuildToolPoolConfig {
    app: VenueApp
    strategyId: string
    venue: VenueAdapter
    pipeline: ExecutionPipeline
    policy: Record<string, unknown>
    extraTools: ToolDefinition[]
    isCallback: boolean
    runLogger: Logger
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

export function buildToolPool(config: BuildToolPoolConfig): ToolPool {
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
    const polymarketHandles = app === "polymarket"
        ? new PolymarketMarketHandleRegistry()
        : undefined

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

                return createPolymarketProposeOrderTool(pipeline, venue, polymarketHandles)
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

                return createPolymarketGetMarketPriceTool(venue, polymarketHandles)
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

                return createPolymarketGetOrderBookTool(venue, polymarketHandles)
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

            return createPolymarketSearchMarketsTool(venue, polymarketHandles)
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
