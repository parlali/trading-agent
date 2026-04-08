import { z } from "zod"
import {
    type ExecutionPipeline,
    type OrderIntent,
} from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"

const genericLegSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    limitPrice: z.number().optional(),
})

const alpacaLegSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy_to_open", "sell_to_open"]),
    quantity: z.number().int().positive(),
})

const genericOrderParamsSchema = z.object({
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

const alpacaOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.literal("sell"),
    quantity: z.number().int().positive(),
    orderType: z.literal("limit"),
    limitPrice: z.number().positive(),
    timeInForce: z.literal("day").default("day"),
    legs: z.array(alpacaLegSchema).length(4),
    metadata: z.record(z.string(), z.unknown()).optional(),
})

interface CreateProposeOrderToolOptions {
    mode?: "default" | "alpaca-options"
}

export function createProposeOrderTool(
    pipeline: ExecutionPipeline,
    options: CreateProposeOrderToolOptions = {}
): ToolDefinition {
    const isAlpacaOptions = options.mode === "alpaca-options"
    const orderParamsSchema = isAlpacaOptions ? alpacaOrderParamsSchema : genericOrderParamsSchema

    return {
        name: "propose_order",
        description: isAlpacaOptions
            ? "Propose a new 4-leg iron condor entry. Use net-credit limit pricing, `day` time in force, and four OCC option legs with explicit open semantics."
            : "Propose a new order. The order is validated by the risk engine before execution. For multi-leg orders (e.g. iron condors), provide the legs array. Returns the execution result including order ID and fill status.",
        parameters: orderParamsSchema,
        jsonSchema: isAlpacaOptions
            ? {
                type: "object",
                properties: {
                    instrument: {
                        type: "string",
                        description: "Structure identifier in the form IC:UNDERLYING:YYYY-MM-DD:QUANTITY",
                    },
                    side: {
                        type: "string",
                        enum: ["sell"],
                        description: "Iron condor entries are submitted as net-credit sells",
                    },
                    quantity: { type: "number", description: "Number of full iron condor structures" },
                    orderType: {
                        type: "string",
                        enum: ["limit"],
                        description: "Only net-credit limit entries are supported for this strategy path",
                    },
                    limitPrice: { type: "number", description: "Net credit limit price for the full 4-leg structure" },
                    timeInForce: {
                        type: "string",
                        enum: ["day"],
                        default: "day",
                    },
                    legs: {
                        type: "array",
                        minItems: 4,
                        maxItems: 4,
                        description: "Exactly four OCC option legs with explicit open semantics",
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
                    metadata: { type: "object", description: "Optional metadata for the order" },
                },
                required: ["instrument", "side", "quantity", "orderType", "limitPrice", "timeInForce", "legs"],
            }
            : {
                type: "object",
                properties: {
                    instrument: { type: "string", description: "The instrument/ticker symbol" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    quantity: { type: "number", description: "Number of units to trade" },
                    orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
                    limitPrice: { type: "number", description: "Limit price for limit/stop_limit orders" },
                    stopPrice: { type: "number", description: "Stop price for stop/stop_limit orders" },
                    timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
                    legs: {
                        type: "array",
                        description: "Multi-leg order components (e.g. for iron condors)",
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
                    metadata: { type: "object", description: "Optional metadata for the order" },
                },
                required: ["instrument", "side", "quantity", "orderType"],
            },
        handler: async (params) => {
            const validated = params as z.infer<typeof orderParamsSchema>
            const [positions, account] = await Promise.all([
                pipeline.getPositions(),
                pipeline.getAccountState(),
            ])

            const intent: OrderIntent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: "stopPrice" in validated ? validated.stopPrice : undefined,
                timeInForce: validated.timeInForce,
                legs: validated.legs,
                metadata: validated.metadata,
            }

            const { result, validation, handle } = await pipeline.executeIntent(intent, account, positions, {
                action: "entry",
            })

            return toExecutionToolResult(result, {
                trackedOrder: handle?.snapshot,
                validation,
            })
        },
    }
}
