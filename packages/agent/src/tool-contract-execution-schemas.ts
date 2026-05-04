import { z } from "zod"
import {
    POLYMARKET_TOKEN_HANDLE_PATTERN,
    POLYMARKET_TOKEN_ID_PATTERN,
} from "./tools/polymarket-market-handles"

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
