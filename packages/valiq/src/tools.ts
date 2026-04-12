import { z } from "zod"
import type { ToolDefinition } from "@valiq-trading/agent"
import type { ValiqDataAdapter } from "./data"
import type { ValiqResearchAdapter } from "./research"
import type { BreakingNewsParams } from "./types"

const researchParamsSchema = z.object({
    question: z.string(),
})

export function createValiqResearchTool(
    research: ValiqResearchAdapter
): ToolDefinition {
    return {
        name: "query_valiq_research",
        description:
            "Send a natural language research question to Val-iQ's agent for analysis. " +
            "Val-iQ has 100+ analysis tools (technical structure, liquidity, sentiment, earnings, macro, screening, backtesting, scenario analysis). " +
            "Use for complex research: iron condor candidate analysis, macro regime assessment, IV surface analysis, multi-factor screening. " +
            "Creates a chat, sends the question, and returns the full analysis. Can take 30-120 seconds.",
        parameters: researchParamsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "Natural language research question for Val-iQ's agent",
                },
            },
            required: ["question"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof researchParamsSchema>
            let chatId = research.getChatId()
            if (!chatId) {
                chatId = await research.createChat()
            }
            const result = await research.sendQuestion(chatId, validated.question)
            return { analysis: result.content }
        },
    }
}

const breakingNewsParamsSchema = z.object({
    window: z.enum(["1h", "6h", "24h", "prev_24h", "7d"]).optional(),
    source: z.enum(["general", "forex", "crypto"]).optional(),
})

export function createValiqBreakingNewsTool(
    data: ValiqDataAdapter
): ToolDefinition {
    return {
        name: "get_breaking_news",
        description:
            "Fetch the latest breaking news articles with sentiment analysis from Val-iQ. " +
            "Returns up to 5 articles with FinBERT sentiment scores plus an aggregated summary. " +
            "Supports time windows (1h, 6h, 24h, prev_24h, 7d) and source filtering (general, forex, crypto). " +
            "Use this to assess current market-moving events and news sentiment.",
        parameters: breakingNewsParamsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                window: {
                    type: "string",
                    description: "Rolling time window for news retrieval",
                    enum: ["1h", "6h", "24h", "prev_24h", "7d"],
                },
                source: {
                    type: "string",
                    description: "Filter by news source. When omitted, returns news from all sources.",
                    enum: ["general", "forex", "crypto"],
                },
            },
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof breakingNewsParamsSchema>
            return data.getBreakingNews(validated)
        },
    }
}

const dataEndpoints = [
    "getEquityOverview",
    "getPerformance",
    "getFinancials",
    "getRatios",
    "getFundamentals",
    "getBeta",
    "getNews",
    "getSentiment",
    "getAnalystRatings",
    "getAnalystTargets",
    "screenAssets",
    "getMacroEconomy",
    "getMacroGrowth",
    "getMacroInflation",
    "getMacroLabor",
    "getMacroStability",
    "getMacroMoneySupply",
    "getMacroEnergy",
    "getMacroOil",
    "getMacroGas",
    "getMacroEvents",
    "getMacroNews",
    "getMacroAnalysis",
    "getMacroRiskFreeRate",
    "getBreakingNews",
] as const

export type ValiqDataEndpoint = (typeof dataEndpoints)[number]

const dataParamsSchema = z.object({
    endpoint: z.enum(dataEndpoints),
    ticker: z.string().optional(),
    region: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
})

export function createValiqDataTool(
    data: ValiqDataAdapter
): ToolDefinition {
    return {
        name: "query_valiq_data",
        description:
            "Call Val-iQ's typed data endpoints for structured non-broker market context. " +
            "Available endpoints: equity overview/performance/financials/ratios/fundamentals/beta/news/sentiment/analyst ratings+targets, " +
            "asset screening, " +
            "macro economy/growth/inflation/labor/stability/money-supply/energy/oil/gas/events/news/analysis/risk-free-rate, breaking-news. " +
            "Pricing and options-chain endpoints are intentionally excluded so broker-native tools remain the live source of truth. " +
            "Provide the endpoint name, ticker or region, and optional parameters.",
        parameters: dataParamsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                endpoint: {
                    type: "string",
                    description: "The data endpoint to call",
                    enum: [...dataEndpoints],
                },
                ticker: {
                    type: "string",
                    description: "Stock ticker symbol (for equity endpoints)",
                },
                region: {
                    type: "string",
                    description: "Region code such as US, EU (for macro endpoints)",
                },
                params: {
                    type: "object",
                    description: "Additional parameters for the endpoint (bucket, limit, window, yearsBack, etc.)",
                },
            },
            required: ["endpoint"],
        },
        handler: async (rawParams) => {
            const validated = rawParams as z.infer<typeof dataParamsSchema>
            const { endpoint, ticker, region, params } = validated

            return routeDataRequest(data, endpoint, ticker, region, params)
        },
    }
}

async function routeDataRequest(
    data: ValiqDataAdapter,
    endpoint: ValiqDataEndpoint,
    ticker?: string,
    region?: string,
    params?: Record<string, unknown>
): Promise<unknown> {
    switch (endpoint) {
        case "getEquityOverview":
            return data.getEquityOverview(requireTicker(ticker))
        case "getPerformance":
            return data.getPerformance(requireTicker(ticker), params?.cutoff as string | undefined)
        case "getFinancials":
            return data.getFinancials(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getRatios":
            return data.getRatios(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getFundamentals":
            return data.getFundamentals(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getBeta":
            return data.getBeta(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getNews":
            return data.getNews(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getSentiment":
            return data.getSentiment(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getAnalystRatings":
            return data.getAnalystRatings(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "getAnalystTargets":
            return data.getAnalystTargets(requireTicker(ticker), params as Record<string, unknown> | undefined)
        case "screenAssets":
            return data.screenAssets(params ?? {})
        case "getMacroEconomy":
            return data.getMacroEconomy(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroGrowth":
            return data.getMacroGrowth(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroInflation":
            return data.getMacroInflation(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroLabor":
            return data.getMacroLabor(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroStability":
            return data.getMacroStability(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroMoneySupply":
            return data.getMacroMoneySupply(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroEnergy":
            return data.getMacroEnergy(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroOil":
            return data.getMacroOil(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroGas":
            return data.getMacroGas(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroEvents":
            return data.getMacroEvents(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroNews":
            return data.getMacroNews(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroAnalysis":
            return data.getMacroAnalysis(requireRegion(region), params as Record<string, unknown> | undefined)
        case "getMacroRiskFreeRate":
            return data.getMacroRiskFreeRate(
                requireRegion(region),
                params as { startDate: string; endDate: string }
            )
        case "getBreakingNews":
            return data.getBreakingNews(params as BreakingNewsParams | undefined)
        default: {
            const exhaustiveCheck: never = endpoint
            throw new Error(`Unknown Val-iQ data endpoint: ${exhaustiveCheck}`)
        }
    }
}

function requireTicker(ticker?: string): string {
    if (!ticker) throw new Error("ticker is required for this endpoint")
    return ticker
}

function requireRegion(region?: string): string {
    if (!region) throw new Error("region is required for this endpoint")
    return region
}
