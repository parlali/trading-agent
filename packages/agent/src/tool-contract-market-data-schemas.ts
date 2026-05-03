import { z } from "zod"
import {
    POLYMARKET_TOKEN_HANDLE_PATTERN,
    POLYMARKET_TOKEN_ID_PATTERN,
} from "./tools/polymarket-market-handles"

export const getOptionsChainParamsSchema = z.object({
    underlyingSymbol: z.string(),
    expirationDate: z.string().optional(),
    expirationDateFrom: z.string().optional(),
    expirationDateTo: z.string().optional(),
    strikePriceGte: z.number().optional(),
    strikePriceLte: z.number().optional(),
    optionType: z.enum(["call", "put"]).optional(),
    limit: z.number().int().positive().max(1000).optional(),
})

export const getOptionsChainJsonSchema = {
    type: "object",
    properties: {
        underlyingSymbol: {
            type: "string",
            description: "Underlying equity symbol such as SPY",
        },
        expirationDate: {
            type: "string",
            description: "Exact expiration date in YYYY-MM-DD format",
        },
        expirationDateFrom: {
            type: "string",
            description: "Earliest expiration date in YYYY-MM-DD format",
        },
        expirationDateTo: {
            type: "string",
            description: "Latest expiration date in YYYY-MM-DD format",
        },
        strikePriceGte: {
            type: "number",
            description: "Minimum strike price filter",
        },
        strikePriceLte: {
            type: "number",
            description: "Maximum strike price filter",
        },
        optionType: {
            type: "string",
            enum: ["call", "put"],
        },
        limit: {
            type: "number",
            description: "Maximum number of contracts to return",
        },
    },
    required: ["underlyingSymbol"],
} satisfies Record<string, unknown>

export const singleSymbolParamsSchema = z.object({
    symbol: z.string(),
})

export const getQuoteJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "Underlying equity symbol such as SPY",
        },
    },
    required: ["symbol"],
} satisfies Record<string, unknown>

export const getSymbolInfoJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "MT5 symbol such as XAUUSD or US30",
        },
    },
    required: ["symbol"],
} satisfies Record<string, unknown>

const polymarketTokenReferenceBaseSchema = z.object({
    tokenId: z.string()
        .trim()
        .regex(POLYMARKET_TOKEN_ID_PATTERN, "Polymarket tokenId must be the canonical 20-80 digit decimal token ID returned by search_markets")
        .optional(),
    tokenHandle: z.string()
        .trim()
        .regex(POLYMARKET_TOKEN_HANDLE_PATTERN, "Polymarket tokenHandle must be returned by search_markets")
        .optional(),
})

const requirePolymarketTokenReference = (value: { tokenId?: string; tokenHandle?: string }): boolean =>
    Boolean(value.tokenId || value.tokenHandle)

export const polymarketTokenReferenceSchema = polymarketTokenReferenceBaseSchema.refine(requirePolymarketTokenReference, {
    message: "Provide tokenHandle from search_markets or a canonical Polymarket tokenId",
    path: ["tokenHandle"],
})

export const polymarketMarketPriceParamsSchema = polymarketTokenReferenceBaseSchema.extend({
    side: z.enum(["buy", "sell"]).optional(),
}).refine(requirePolymarketTokenReference, {
    message: "Provide tokenHandle from search_markets or a canonical Polymarket tokenId",
    path: ["tokenHandle"],
})

export const polymarketMarketPriceJsonSchema = {
    type: "object",
    properties: {
        tokenHandle: {
            type: "string",
            description: "Preferred short token handle returned by search_markets for this run",
        },
        tokenId: {
            type: "string",
            description: "Canonical long decimal Polymarket token ID returned by search_markets. Prefer tokenHandle when available.",
        },
        side: {
            type: "string",
            enum: ["buy", "sell"],
            description: "Optional side to include the current executable price",
        },
    },
} satisfies Record<string, unknown>

export const okxMarketPriceJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "OKX swap instrument such as BTC-USDT-SWAP or ETH-USDT-SWAP",
        },
    },
    required: ["symbol"],
} satisfies Record<string, unknown>

export const polymarketOrderBookParamsSchema = polymarketTokenReferenceBaseSchema.extend({
    levels: z.number().int().positive().max(50).optional(),
}).refine(requirePolymarketTokenReference, {
    message: "Provide tokenHandle from search_markets or a canonical Polymarket tokenId",
    path: ["tokenHandle"],
})

export const polymarketOrderBookJsonSchema = {
    type: "object",
    properties: {
        tokenHandle: {
            type: "string",
            description: "Preferred short token handle returned by search_markets for this run",
        },
        tokenId: {
            type: "string",
            description: "Canonical long decimal Polymarket token ID returned by search_markets. Prefer tokenHandle when available.",
        },
        levels: {
            type: "number",
            description: "Optional number of bid and ask levels to return",
        },
    },
} satisfies Record<string, unknown>

export const okxOrderBookParamsSchema = z.object({
    symbol: z.string(),
    limit: z.number().int().positive().max(1000).optional(),
})

export const okxOrderBookJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "OKX swap instrument such as BTC-USDT-SWAP or ETH-USDT-SWAP",
        },
        limit: {
            type: "number",
            description: "Depth limit passed to OKX",
        },
    },
    required: ["symbol"],
} satisfies Record<string, unknown>

export const searchMarketsParamsSchema = z.object({
    category: z.string().trim().max(80).optional(),
    query: z.string()
        .trim()
        .max(500)
        .transform(normalizePolymarketSearchQuery)
        .optional(),
    conditionId: z.string().trim().max(120).optional(),
    marketSlug: z.string().trim().max(160).optional(),
    limit: z.number()
        .int()
        .positive()
        .transform((limit) => Math.min(limit, 25))
        .optional(),
    includeLivePrices: z.boolean().optional(),
    livePriceTokenLimit: z.number()
        .int()
        .nonnegative()
        .max(25)
        .optional(),
})

export const searchMarketsJsonSchema = {
    type: "object",
    properties: {
        category: {
            type: "string",
            description: "Polymarket category/tag slug such as politics, crypto, finance, or world",
        },
        query: {
            type: "string",
            description: "Optional search text to narrow the Gamma category or public-search results",
        },
        conditionId: {
            type: "string",
            description: "Exact Polymarket condition ID",
        },
        marketSlug: {
            type: "string",
            description: "Exact Polymarket market or event slug, for example from a Polymarket URL",
        },
        limit: {
            type: "number",
            description: "Maximum number of markets to return",
        },
        includeLivePrices: {
            type: "boolean",
            description: "Opt-in live Polymarket CLOB price enrichment for returned token IDs. Leave unset for Gamma-only discovery.",
        },
        livePriceTokenLimit: {
            type: "number",
            description: "Maximum number of token IDs to enrich with live prices when includeLivePrices is true. Use 0 to disable live price enrichment. The venue adapter applies the hard cap.",
        },
    },
} satisfies Record<string, unknown>

export function normalizePolymarketSearchQuery(query: string): string {
    return query
        .replace(/[()[\]{}"`]/g, " ")
        .replace(/\b(?:and|or|not)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160)
}

export const webSearchParamsSchema = z.object({
    query: z.string(),
    maxResults: z.number().int().positive().max(20).default(5),
})

export const webSearchJsonSchema = {
    type: "object",
    properties: {
        query: { type: "string", description: "The search query" },
        maxResults: { type: "number", description: "Maximum number of results (1-20, default 5)" },
    },
    required: ["query"],
} satisfies Record<string, unknown>

export const webFetchParamsSchema = z.object({
    url: z.string().url(),
    maxLength: z.number().int().positive().default(10000),
})

export const webFetchJsonSchema = {
    type: "object",
    properties: {
        url: { type: "string", description: "The URL to fetch" },
        maxLength: { type: "number", description: "Maximum characters to return (default 10000)" },
    },
    required: ["url"],
} satisfies Record<string, unknown>
