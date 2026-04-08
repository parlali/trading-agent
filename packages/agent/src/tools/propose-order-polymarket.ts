import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"
import { resolveEstimatedPrice, type PolymarketPriceProvider } from "./polymarket-order-helpers"

const legSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    limitPrice: z.number().optional(),
})

const orderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
    legs: z.array(legSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
})

export function createPolymarketProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider
): ToolDefinition {
    return {
        name: "propose_order",
        description: "Propose a new order. The order is validated by the risk engine before execution. For multi-leg orders (e.g. iron condors), provide the legs array. Returns the execution result including order ID and fill status.",
        parameters: orderParamsSchema,
        jsonSchema: {
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

            const estimatedPrice = await resolveEstimatedPrice(
                venue,
                validated.instrument,
                validated.side,
                validated.limitPrice
            )

            const intent: OrderIntent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: validated.stopPrice,
                timeInForce: validated.timeInForce,
                legs: validated.legs,
                metadata: {
                    ...validated.metadata,
                    estimatedPrice,
                },
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
