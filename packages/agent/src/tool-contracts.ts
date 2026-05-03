import { VENUE_APPS, type VenueApp } from "@valiq-trading/core"
import { z } from "zod"
import {
    getOptionsChainJsonSchema,
    getOptionsChainParamsSchema,
    getQuoteJsonSchema,
    getSymbolInfoJsonSchema,
    okxMarketPriceJsonSchema,
    okxOrderBookJsonSchema,
    okxOrderBookParamsSchema,
    polymarketMarketPriceJsonSchema,
    polymarketMarketPriceParamsSchema,
    polymarketOrderBookJsonSchema,
    polymarketOrderBookParamsSchema,
    searchMarketsJsonSchema,
    searchMarketsParamsSchema,
    singleSymbolParamsSchema,
    webFetchJsonSchema,
    webFetchParamsSchema,
    webSearchJsonSchema,
    webSearchParamsSchema,
} from "./tool-contract-market-data-schemas"
import {
    okxOrderJsonSchema,
    okxOrderParamsSchema,
} from "./tools/okx-order-helpers"
import {
    mt5OrderJsonSchema,
    mt5OrderParamsSchema,
} from "./tools/mt5-order-helpers"
import {
    POLYMARKET_TOKEN_HANDLE_PATTERN,
    POLYMARKET_TOKEN_ID_PATTERN,
} from "./tools/polymarket-market-handles"
import type { ToolCategory, ToolDefinition } from "./tool-registry"

export {
    getOptionsChainJsonSchema,
    getOptionsChainParamsSchema,
    getQuoteJsonSchema,
    getSymbolInfoJsonSchema,
    okxMarketPriceJsonSchema,
    okxOrderBookJsonSchema,
    okxOrderBookParamsSchema,
    polymarketMarketPriceJsonSchema,
    polymarketMarketPriceParamsSchema,
    polymarketOrderBookJsonSchema,
    polymarketOrderBookParamsSchema,
    searchMarketsJsonSchema,
    searchMarketsParamsSchema,
    singleSymbolParamsSchema,
    webFetchJsonSchema,
    webFetchParamsSchema,
    webSearchJsonSchema,
    webSearchParamsSchema,
} from "./tool-contract-market-data-schemas"

export type ToolContractBoundary = "shared" | "venue-owned"

export interface ToolContractVariant {
    description: string
    parameters: z.ZodTypeAny
    jsonSchema: Record<string, unknown>
    outputDescription: string
    errorSemantics: string
}

export interface ToolContractDefinition {
    name: string
    category: ToolCategory
    boundary: ToolContractBoundary
    owner: string
    compatibleVenues: readonly VenueApp[]
    defaultVariant?: ToolContractVariant
    variants?: Partial<Record<VenueApp, ToolContractVariant>>
}

export interface ResolvedToolContract extends ToolContractVariant {
    name: string
    category: ToolCategory
    boundary: ToolContractBoundary
    owner: string
    compatibleVenues: readonly VenueApp[]
}

export const emptyParamsSchema = z.object({})

export const orderIdParamsSchema = z.object({
    orderId: z.string(),
})

export const orderIdWithReasonParamsSchema = z.object({
    orderId: z.string(),
    reason: z.string().optional(),
})

export const waitForOrderUpdateParamsSchema = z.object({
    orderId: z.string(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
})

export const genericLegSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    limitPrice: z.number().optional(),
})

export const alpacaLegSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy_to_open", "sell_to_open"]),
    quantity: z.number().int().positive(),
})

export const genericOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
    legs: z.array(genericLegSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
})

export const genericOrderJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument or ticker symbol" },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number", description: "Number of units to trade" },
        orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
        limitPrice: { type: "number", description: "Limit price for limit or stop_limit orders" },
        stopPrice: { type: "number", description: "Stop price for stop or stop_limit orders" },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
        legs: {
            type: "array",
            description: "Optional multi-leg order components",
            items: {
                type: "object",
                properties: {
                    instrument: { type: "string" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    quantity: { type: "number" },
                    limitPrice: { type: "number" },
                },
                required: ["instrument", "side", "quantity"],
            },
        },
        metadata: { type: "object", description: "Optional metadata for deterministic processing" },
    },
    required: ["instrument", "side", "quantity", "orderType"],
} satisfies Record<string, unknown>

export const polymarketOrderParamsSchema = z.object({
    tokenHandle: z.string()
        .trim()
        .regex(POLYMARKET_TOKEN_HANDLE_PATTERN, "Polymarket tokenHandle must be returned by search_markets")
        .optional(),
    tokenId: z.string()
        .trim()
        .regex(POLYMARKET_TOKEN_ID_PATTERN, "Polymarket tokenId must be the canonical 20-80 digit decimal token ID returned by search_markets")
        .optional(),
    conditionId: z.string().trim().min(1).optional(),
    marketSlug: z.string().trim().min(1).optional(),
    question: z.string().trim().min(1).optional(),
    outcome: z.string().trim().min(1).optional(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit"]),
    limitPrice: z.number().positive().max(1).optional(),
    timeInForce: z.enum(["gtc", "ioc", "fok"]).default("gtc"),
    category: z.string().optional(),
    endDateIso: z.string().optional(),
    liquidity: z.number().optional(),
    volume: z.number().optional(),
    negRisk: z.boolean().optional(),
}).superRefine((value, ctx) => {
    if (!value.tokenHandle && !value.tokenId) {
        ctx.addIssue({
            code: "custom",
            path: ["tokenHandle"],
            message: "Provide tokenHandle from search_markets or a canonical Polymarket tokenId",
        })
    }

    if (!value.tokenHandle) {
        for (const field of ["conditionId", "marketSlug", "question", "outcome"] as const) {
            if (!value[field]) {
                ctx.addIssue({
                    code: "custom",
                    path: [field],
                    message: `${field} is required when tokenHandle is not provided`,
                })
            }
        }
    }
})

export const polymarketOrderJsonSchema = {
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
        conditionId: {
            type: "string",
            description: "Canonical Polymarket condition ID for the market",
        },
        marketSlug: {
            type: "string",
            description: "Polymarket market slug from discovery or direct lookup",
        },
        question: {
            type: "string",
            description: "Exact market question from Polymarket",
        },
        outcome: {
            type: "string",
            description: "Exact token outcome being traded, such as Yes or No",
        },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number", description: "Number of outcome shares" },
        orderType: {
            type: "string",
            enum: ["market", "limit"],
            description: "Use limit unless intentionally crossing the book with a bounded IOC/FOK order",
        },
        limitPrice: {
            type: "number",
            description: "Limit price between 0 and 1. Required for limit orders.",
        },
        timeInForce: {
            type: "string",
            enum: ["gtc", "ioc", "fok"],
            default: "gtc",
        },
        category: {
            type: "string",
            description: "Market category from discovery, used by risk validation",
        },
        endDateIso: {
            type: "string",
            description: "Market resolution/end date from discovery",
        },
        liquidity: {
            type: "number",
            description: "Market liquidity from discovery",
        },
        volume: {
            type: "number",
            description: "Market volume from discovery",
        },
        negRisk: {
            type: "boolean",
            description: "Whether the market uses Polymarket negative-risk settlement",
        },
    },
    required: ["side", "quantity", "orderType"],
} satisfies Record<string, unknown>

export const alpacaOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.literal("sell"),
    quantity: z.number().int().positive(),
    orderType: z.literal("limit"),
    limitPrice: z.number().positive(),
    timeInForce: z.literal("day").default("day"),
    legs: z.array(alpacaLegSchema).refine((legs) => legs.length === 2 || legs.length === 4, {
        message: "Alpaca options structures must contain exactly 2 or 4 legs",
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
})

export const alpacaOrderJsonSchema = {
    type: "object",
    properties: {
        instrument: {
            type: "string",
            description: "Structure identifier. Iron condors use IC:UNDERLYING:YYYY-MM-DD and credit verticals use VS:TYPE:UNDERLYING:YYYY-MM-DD with normalized leg sets.",
        },
        side: {
            type: "string",
            enum: ["sell"],
            description: "Alpaca multi-leg credit entries are submitted as net-credit sells",
        },
        quantity: { type: "number", description: "Number of full structure units" },
        orderType: {
            type: "string",
            enum: ["limit"],
            description: "Only net-credit limit entries are supported for this strategy path",
        },
        limitPrice: { type: "number", description: "Positive net credit limit price for the full structure. The system translates it to Alpaca's signed `mleg` wire value." },
        timeInForce: {
            type: "string",
            enum: ["day"],
            default: "day",
        },
        legs: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "Exactly two legs for one-sided credit verticals or four legs for iron condors, all with explicit open semantics",
            items: {
                type: "object",
                properties: {
                    instrument: { type: "string", description: "OCC option symbol, e.g. SPY260410P00510000" },
                    side: {
                        type: "string",
                        enum: ["buy_to_open", "sell_to_open"],
                    },
                    quantity: { type: "number", description: "Leg ratio quantity. Use integer 1 for each leg." },
                },
                required: ["instrument", "side", "quantity"],
            },
        },
        metadata: { type: "object", description: "Optional metadata for deterministic processing" },
    },
    required: ["instrument", "side", "quantity", "orderType", "limitPrice", "timeInForce", "legs"],
} satisfies Record<string, unknown>

export const genericAdjustmentParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
    reason: z.string(),
})

export const genericAdjustmentJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument to adjust" },
        side: { type: "string", enum: ["buy", "sell"], description: "Direction of the adjustment" },
        quantity: { type: "number", description: "Quantity to add or reduce" },
        orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
        limitPrice: { type: "number" },
        stopPrice: { type: "number" },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
        reason: { type: "string", description: "Why this adjustment is being made" },
    },
    required: ["instrument", "side", "quantity", "orderType", "reason"],
} satisfies Record<string, unknown>

export const okxAdjustmentParamsSchema = z.object({
    instrument: z.string(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    reason: z.string(),
})

export const okxAdjustmentJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "OKX swap instrument, e.g. BTC-USDT-SWAP or ETH-USDT-SWAP" },
        stopLoss: { type: "number", description: "New stop-loss price" },
        takeProfit: { type: "number", description: "New take-profit price" },
        reason: { type: "string", description: "Why this adjustment is needed" },
    },
    required: ["instrument", "reason"],
} satisfies Record<string, unknown>

export const closeParamsSchema = z.object({
    instrument: z.string(),
    reason: z.string(),
})

export const closeJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument to close the position for" },
        reason: { type: "string", description: "Why the position is being closed" },
    },
    required: ["instrument", "reason"],
} satisfies Record<string, unknown>

export const defaultModifyOrderParamsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    quantity: z.number().positive().optional(),
    reason: z.string().optional(),
})

export const defaultModifyOrderJsonSchema = {
    type: "object",
    properties: {
        orderId: { type: "string", description: "The order ID to modify" },
        limitPrice: { type: "number", description: "New limit price" },
        stopPrice: { type: "number", description: "New stop price" },
        quantity: { type: "number", description: "New quantity" },
        reason: { type: "string", description: "Why the order is being modified" },
    },
    required: ["orderId"],
} satisfies Record<string, unknown>

export const alpacaModifyOrderParamsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    reason: z.string().optional(),
})

export const alpacaModifyOrderJsonSchema = {
    type: "object",
    properties: {
        orderId: { type: "string", description: "The order ID to modify" },
        limitPrice: { type: "number", description: "New positive net limit price for the full structure. The system handles Alpaca's signed `mleg` wire value." },
        quantity: { type: "number", description: "Optional new structure quantity" },
        reason: { type: "string", description: "Why the order is being modified" },
    },
    required: ["orderId"],
} satisfies Record<string, unknown>

export const mt5ModifyOrderParamsSchema = z.object({
    orderId: z.number().int().positive(),
    newStopLoss: z.number().optional(),
    newTakeProfit: z.number().optional(),
    reason: z.string().optional(),
}).refine(
    (value) => value.newStopLoss !== undefined || value.newTakeProfit !== undefined,
    {
        message: "Provide newStopLoss, newTakeProfit, or both",
        path: ["newStopLoss"],
    }
)

export const mt5ModifyOrderJsonSchema = {
    type: "object",
    properties: {
        orderId: { type: "number", description: "Numeric MT5 order ticket to modify" },
        newStopLoss: { type: "number", description: "New absolute stop-loss price" },
        newTakeProfit: { type: "number", description: "New absolute take-profit price" },
        reason: { type: "string", description: "Why the protective levels are changing" },
    },
    required: ["orderId"],
} satisfies Record<string, unknown>

const OPENROUTER_UNSUPPORTED_TOP_LEVEL_JSON_SCHEMA_KEYS = [
    "oneOf",
    "anyOf",
    "allOf",
    "enum",
    "not",
] as const

function validateOpenRouterToolJsonSchema(
    schema: Record<string, unknown>,
    label: string
): void {
    for (const key of OPENROUTER_UNSUPPORTED_TOP_LEVEL_JSON_SCHEMA_KEYS) {
        if (key in schema) {
            throw new Error(
                `Tool schema ${label} uses unsupported top-level JSON Schema keyword ${key}`
            )
        }
    }
}

function validateToolContractJsonSchemas(contract: ToolContractDefinition): void {
    if (contract.defaultVariant) {
        validateOpenRouterToolJsonSchema(
            contract.defaultVariant.jsonSchema,
            `${contract.name} default`
        )
    }

    for (const [venue, variant] of Object.entries(contract.variants ?? {})) {
        validateOpenRouterToolJsonSchema(
            variant.jsonSchema,
            `${contract.name} variant:${venue}`
        )
    }
}

const toolContracts = createToolContractCatalog([
    {
        name: "get_positions",
        category: "account",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Get all current open positions. Returns instrument, side, quantity, entry price, current price, and unrealized P&L for each position.",
            parameters: emptyParamsSchema,
            jsonSchema: { type: "object", properties: {} },
            outputDescription: "Returns the open positions array or an empty array when nothing is open.",
            errorSemantics: "Returns current broker or dry-run state. Transport or adapter failures throw.",
        },
    },
    {
        name: "get_account",
        category: "account",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Get the strategy-scoped account state including allocated balance, buying power budget, margin usage, and strategy P&L.",
            parameters: emptyParamsSchema,
            jsonSchema: { type: "object", properties: {} },
            outputDescription: "Returns the current normalized strategy account snapshot.",
            errorSemantics: "Returns current broker or dry-run state. Transport or adapter failures throw.",
        },
    },
    {
        name: "get_order_status",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Check the current fill status of a tracked order. Returns the latest status, fill progress, and lifecycle snapshot.",
            parameters: orderIdParamsSchema,
            jsonSchema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The order ID to check" },
                },
                required: ["orderId"],
            },
            outputDescription: "Returns the normalized execution status plus any tracked order snapshot.",
            errorSemantics: "Known order lookup failures return a structured error payload instead of throwing.",
        },
    },
    {
        name: "cancel_order",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Cancel a pending unfilled order. Provide the order ID.",
            parameters: orderIdWithReasonParamsSchema,
            jsonSchema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The order ID to cancel" },
                    reason: { type: "string", description: "Why the order is being cancelled" },
                },
                required: ["orderId"],
            },
            outputDescription: "Returns the normalized cancellation result plus any tracked order snapshot.",
            errorSemantics: "Validation or broker rejections are returned in the execution payload.",
        },
    },
    {
        name: "wait_for_order_update",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Wait for the next order lifecycle update in the current run. Use this when an order is still pending or partially filled and you need the refreshed snapshot before deciding what to do next.",
            parameters: waitForOrderUpdateParamsSchema,
            jsonSchema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The tracked order ID to wait on" },
                    timeoutMs: { type: "number", description: "Optional maximum wait for this tool call in milliseconds" },
                },
                required: ["orderId"],
            },
            outputDescription: "Returns the refreshed tracked order snapshot after the next lifecycle update or timeout boundary.",
            errorSemantics: "Wait failures throw. Timeout behavior is surfaced through the returned polling state.",
        },
    },
    {
        name: "propose_order",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        variants: {
            "alpaca-options": {
                description: "Propose a new Alpaca multi-leg credit entry. Use a positive net-credit `limitPrice`, `day` time in force, and either a 2-leg one-sided credit vertical (bull put or bear call) or a 4-leg iron condor with explicit open semantics. The system converts the price to Alpaca's signed `mleg` wire format.",
                parameters: alpacaOrderParamsSchema,
                jsonSchema: alpacaOrderJsonSchema,
                outputDescription: "Returns the normalized execution result, risk validation, and tracked order snapshot for the structure.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload.",
            },
            polymarket: {
                description: "Propose a Polymarket order using a canonical token ID plus exact market identity from search_markets or direct lookup. Never submit a condition ID, event slug, or question as the tradable instrument.",
                parameters: polymarketOrderParamsSchema,
                jsonSchema: polymarketOrderJsonSchema,
                outputDescription: "Returns the normalized execution result, risk validation, and tracked order snapshot for the proposed order.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload. Estimated execution pricing is injected from live venue data.",
            },
            mt5: {
                description: [
                    "Propose a new MT5 order.",
                    "You must provide stopLoss and either takeProfit or riskRewardRatio, not both.",
                    "Position size is calculated automatically so that hitting your stop-loss loses exactly maxRiskPercent of account balance.",
                    "Do not specify quantity or lot size because it is computed for you.",
                    "Returns the execution result including computed lot size, risk amount, and risk-reward ratio.",
                ].join(" "),
                parameters: mt5OrderParamsSchema,
                jsonSchema: mt5OrderJsonSchema,
                outputDescription: "Returns the normalized execution result plus computed sizing, risk, and price verification details.",
                errorSemantics: "Pre-validation failures return a structured rejected payload instead of throwing.",
            },
            "okx-swap": {
                description: [
                    "Propose a new OKX perpetual swap entry order for a canonical instrument such as BTC-USDT-SWAP or ETH-USDT-SWAP.",
                    "You must provide stopLoss and either takeProfit or riskRewardRatio.",
                    "Position size is calculated automatically from maxRiskPercent and stop distance.",
                    "Leverage defaults to policy maxLeverage and cannot exceed it.",
                    "Only market and limit entries are supported in this execution path.",
                    "For filled entries, protective stop-loss and take-profit orders are attached automatically.",
                ].join(" "),
                parameters: okxOrderParamsSchema,
                jsonSchema: okxOrderJsonSchema,
                outputDescription: "Returns the normalized execution result plus computed sizing, leverage, and protection-order details.",
                errorSemantics: "Pre-validation failures return a structured rejected payload instead of throwing.",
            },
        },
    },
    {
        name: "propose_adjustment",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        variants: {
            "alpaca-options": {
                description: "Propose adjusting an existing position by adding to or partially reducing it. Provide the instrument, direction, and quantity of the adjustment. Include a reason for the adjustment.",
                parameters: genericAdjustmentParamsSchema,
                jsonSchema: genericAdjustmentJsonSchema,
                outputDescription: "Returns the normalized adjustment execution result plus risk validation details.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload.",
            },
            polymarket: {
                description: "Propose adjusting an existing position by adding to or partially reducing it. Provide the instrument, direction, and quantity of the adjustment. Include a reason for the adjustment.",
                parameters: genericAdjustmentParamsSchema,
                jsonSchema: genericAdjustmentJsonSchema,
                outputDescription: "Returns the normalized adjustment execution result plus risk validation details.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload. Estimated execution pricing is injected from live venue data.",
            },
            mt5: {
                description: [
                    "Propose adjusting an existing MT5 position by adding to it.",
                    "You must provide stopLoss and either takeProfit or riskRewardRatio, not both.",
                    "Position size is calculated automatically so that hitting your stop-loss loses exactly maxRiskPercent of account balance.",
                    "Do not specify quantity or lot size because it is computed for you.",
                    "Include a reason for the adjustment.",
                ].join(" "),
                parameters: mt5OrderParamsSchema,
                jsonSchema: mt5OrderJsonSchema,
                outputDescription: "Returns the normalized adjustment execution result plus computed sizing and risk details.",
                errorSemantics: "Pre-validation failures return a structured rejected payload instead of throwing.",
            },
            "okx-swap": {
                description: "Update protective stop-loss and take-profit orders for an existing OKX perpetual swap position.",
                parameters: okxAdjustmentParamsSchema,
                jsonSchema: okxAdjustmentJsonSchema,
                outputDescription: "Returns the protection-order update result including cancelled and recreated protection order IDs.",
                errorSemantics: "Missing protection levels or missing positions return a structured rejected payload instead of throwing.",
            },
        },
    },
    {
        name: "propose_close",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Propose closing an entire position for a given instrument. Provide the instrument and a reason for closing.",
            parameters: closeParamsSchema,
            jsonSchema: closeJsonSchema,
            outputDescription: "Returns the normalized close execution result plus risk validation details.",
            errorSemantics: "Broker or policy rejections are returned in the execution payload.",
        },
    },
    {
        name: "modify_order",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: ["alpaca-options", "polymarket", "mt5"],
        variants: {
            "alpaca-options": {
                description: "Modify a working Alpaca multi-leg options order. Supported changes are the positive net limit price and, if truly necessary, the structure quantity. The system handles Alpaca's signed `mleg` wire price.",
                parameters: alpacaModifyOrderParamsSchema,
                jsonSchema: alpacaModifyOrderJsonSchema,
                outputDescription: "Returns the normalized order modification result plus the refreshed tracked order snapshot.",
                errorSemantics: "Broker rejections are returned in the execution payload.",
            },
            polymarket: {
                description: "Modify a pending order. You can change the limit price, stop price, or quantity. At least one modification field must be provided.",
                parameters: defaultModifyOrderParamsSchema,
                jsonSchema: defaultModifyOrderJsonSchema,
                outputDescription: "Returns the normalized order modification result plus the refreshed tracked order snapshot.",
                errorSemantics: "Broker rejections are returned in the execution payload.",
            },
            mt5: {
                description: "Adjust stop-loss and or take-profit on an existing MT5 position using its numeric order ticket. Quantity and entry price changes are not supported.",
                parameters: mt5ModifyOrderParamsSchema,
                jsonSchema: mt5ModifyOrderJsonSchema,
                outputDescription: "Returns the normalized order modification result plus the refreshed tracked order snapshot.",
                errorSemantics: "Missing protective fields fail schema validation before execution. Broker rejections are returned in the execution payload.",
            },
        },
    },
    {
        name: "get_options_chain",
        category: "market-data",
        boundary: "venue-owned",
        owner: "alpaca-options",
        compatibleVenues: ["alpaca-options"],
        defaultVariant: {
            description: "Fetch the live Alpaca options chain for an underlying. Returns contracts with current bid and ask, midpoint, latest trade, greeks, implied volatility, open interest, and canonical executionCost derived from Alpaca market data.",
            parameters: getOptionsChainParamsSchema,
            jsonSchema: getOptionsChainJsonSchema,
            outputDescription: "Returns normalized options contracts with canonical executionCost fields and any pagination token from Alpaca.",
            errorSemantics: "Venue lookup failures throw.",
        },
    },
    {
        name: "get_quote",
        category: "market-data",
        boundary: "venue-owned",
        owner: "alpaca-options",
        compatibleVenues: ["alpaca-options"],
        defaultVariant: {
            description: "Fetch the latest live Alpaca quote for an equity underlying. Returns current bid, ask, last trade price, recent bars, and canonical executionCost.",
            parameters: singleSymbolParamsSchema,
            jsonSchema: getQuoteJsonSchema,
            outputDescription: "Returns the current normalized equity quote, recent bar snapshot, and canonical executionCost.",
            errorSemantics: "Venue lookup failures throw.",
        },
    },
    {
        name: "get_symbol_info",
        category: "market-data",
        boundary: "venue-owned",
        owner: "mt5",
        compatibleVenues: ["mt5"],
        defaultVariant: {
            description: "Fetch live MT5 symbol information including bid, ask, normalized spread with its unit, canonical executionCost, tick value, contract size, and volume constraints.",
            parameters: singleSymbolParamsSchema,
            jsonSchema: getSymbolInfoJsonSchema,
            outputDescription: "Returns normalized MT5 symbol metadata, including spread, spreadUnit, and canonical executionCost, or a found:false payload when the symbol is unavailable.",
            errorSemantics: "Missing symbols return found:false. Worker or transport failures throw.",
        },
    },
    {
        name: "get_market_price",
        category: "market-data",
        boundary: "venue-owned",
        owner: "venue-extension",
        compatibleVenues: ["polymarket", "okx-swap"],
        variants: {
            polymarket: {
                description: "Fetch the current Polymarket midpoint, best bid, best ask, spread, optional executable price, liquidityWarning, and canonical executionCost derived from one /book snapshot.",
                parameters: polymarketMarketPriceParamsSchema,
                jsonSchema: polymarketMarketPriceJsonSchema,
                outputDescription: "Returns normalized Polymarket pricing, spread, liquidity warning, and canonical executionCost information for the requested token.",
                errorSemantics: "Venue lookup failures throw.",
            },
            "okx-swap": {
                description: "Fetch the current OKX swap mark price, last price, best bid, best ask, spread, funding rate, next funding time, and canonical executionCost for an instrument.",
                parameters: singleSymbolParamsSchema,
                jsonSchema: okxMarketPriceJsonSchema,
                outputDescription: "Returns normalized OKX swap pricing, spread, funding, and canonical executionCost information for the requested instrument.",
                errorSemantics: "Venue lookup failures throw.",
            },
        },
    },
    {
        name: "get_order_book",
        category: "market-data",
        boundary: "venue-owned",
        owner: "venue-extension",
        compatibleVenues: ["polymarket", "okx-swap"],
        variants: {
            polymarket: {
                description: "Fetch the live Polymarket order book for a token. Use this to assess spread and available depth before sizing an order.",
                parameters: polymarketOrderBookParamsSchema,
                jsonSchema: polymarketOrderBookJsonSchema,
                outputDescription: "Returns normalized Polymarket order book depth for the requested token.",
                errorSemantics: "Venue lookup failures throw.",
            },
            "okx-swap": {
                description: "Fetch the live OKX swap order book for an instrument. Use this to assess depth and likely slippage before sizing larger entries.",
                parameters: okxOrderBookParamsSchema,
                jsonSchema: okxOrderBookJsonSchema,
                outputDescription: "Returns normalized OKX swap order book depth for the requested instrument.",
                errorSemantics: "Venue lookup failures throw.",
            },
        },
    },
    {
        name: "search_markets",
        category: "market-data",
        boundary: "venue-owned",
        owner: "polymarket",
        compatibleVenues: ["polymarket"],
        defaultVariant: {
            description: "Discover active Polymarket markets via Gamma, or look up a direct condition ID or market slug. Use this to get a top-liquid candidate list and token IDs first, then request live prices or order books only for your best candidate markets.",
            parameters: searchMarketsParamsSchema,
            jsonSchema: searchMarketsJsonSchema,
            outputDescription: "Returns normalized Polymarket market discovery results. By default this is Gamma-only metadata plus token IDs; optional live price enrichment adds venue pricing and executionCost for a tightly capped token subset.",
            errorSemantics: "Empty requests throw before venue lookup. Harmless optional enrichment fields are ignored when enrichment is disabled.",
        },
    },
    {
        name: "web_search",
        category: "web",
        boundary: "venue-owned",
        owner: "polymarket",
        compatibleVenues: ["polymarket"],
        defaultVariant: {
            description: "Search the internet for information. Returns a list of results with title, URL, and snippet. Useful for market news, event research, and finding current information.",
            parameters: webSearchParamsSchema,
            jsonSchema: webSearchJsonSchema,
            outputDescription: "Returns normalized web search results.",
            errorSemantics: "Provider failures throw unless the provider itself returns a degraded result.",
        },
    },
    {
        name: "web_fetch",
        category: "web",
        boundary: "venue-owned",
        owner: "polymarket",
        compatibleVenues: ["polymarket"],
        defaultVariant: {
            description: "Fetch the content of a specific URL and return it as text. HTML tags are stripped. Content is truncated to maxLength characters.",
            parameters: webFetchParamsSchema,
            jsonSchema: webFetchJsonSchema,
            outputDescription: "Returns fetched content, truncated content length, or a structured fetch error payload.",
            errorSemantics: "HTTP and fetch failures are returned as payload errors instead of throwing where possible.",
        },
    },
])

export function createToolContractCatalog(
    contracts: readonly ToolContractDefinition[]
): Map<string, ToolContractDefinition> {
    const catalog = new Map<string, ToolContractDefinition>()

    for (const contract of contracts) {
        if (catalog.has(contract.name)) {
            throw new Error(`Duplicate tool contract definition detected for ${contract.name}`)
        }

        const variantVenues = Object.keys(contract.variants ?? {}) as VenueApp[]
        for (const venue of variantVenues) {
            if (!contract.compatibleVenues.includes(venue)) {
                throw new Error(`Tool contract ${contract.name} defines unsupported venue variant ${venue}`)
            }
        }

        if (!contract.defaultVariant) {
            for (const venue of contract.compatibleVenues) {
                if (!contract.variants?.[venue]) {
                    throw new Error(`Tool contract ${contract.name} is missing a variant for ${venue}`)
                }
            }
        }

        validateToolContractJsonSchemas(contract)

        catalog.set(contract.name, contract)
    }

    return catalog
}

export function getToolContract(
    name: string,
    venue?: VenueApp
): ResolvedToolContract {
    const contract = toolContracts.get(name)
    if (!contract) {
        throw new Error(`Unknown tool contract: ${name}`)
    }

    if (venue && !contract.compatibleVenues.includes(venue)) {
        throw new Error(`Tool ${name} is not compatible with venue ${venue}`)
    }

    const variant = venue
        ? contract.variants?.[venue] ?? contract.defaultVariant
        : contract.defaultVariant ?? firstVariant(contract)

    if (!variant) {
        throw new Error(`Tool contract ${name} has no resolvable variant`)
    }

    return {
        name: contract.name,
        category: contract.category,
        boundary: contract.boundary,
        owner: contract.owner,
        compatibleVenues: contract.compatibleVenues,
        description: variant.description,
        parameters: variant.parameters,
        jsonSchema: variant.jsonSchema,
        outputDescription: variant.outputDescription,
        errorSemantics: variant.errorSemantics,
    }
}

export function getToolCategory(name: string): ToolCategory {
    return getToolContract(name).category
}

export function getToolBoundary(name: string): ToolContractBoundary {
    return getToolContract(name).boundary
}

export function listToolContracts(): ResolvedToolContract[] {
    return Array.from(toolContracts.keys()).map((name) => getToolContract(name))
}

export function createToolDefinition(config: {
    name: string
    venue?: VenueApp
    handler: ToolDefinition["handler"]
}): ToolDefinition {
    const contract = getToolContract(config.name, config.venue)

    return {
        name: contract.name,
        description: contract.description,
        parameters: contract.parameters,
        jsonSchema: contract.jsonSchema,
        category: contract.category,
        compatibleVenues: contract.compatibleVenues,
        contractBoundary: contract.boundary,
        contractOwner: contract.owner,
        outputDescription: contract.outputDescription,
        errorSemantics: contract.errorSemantics,
        handler: config.handler,
    }
}

function firstVariant(
    contract: ToolContractDefinition
): ToolContractVariant | undefined {
    if (!contract.variants) {
        return undefined
    }

    for (const venue of contract.compatibleVenues) {
        const variant = contract.variants[venue]
        if (variant) {
            return variant
        }
    }

    return undefined
}
