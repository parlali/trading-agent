import type { ExecutionPipeline, MT5Policy } from "@valiq-trading/core"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import type { ToolDefinition } from "../tool-registry"
import { createToolDefinition } from "../tool-contracts"
import {
    prepareMT5Order,
    type MT5OrderParams,
} from "./mt5-order-helpers"

export function createMT5ProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: MT5VenueAdapter,
    policy: MT5Policy
): ToolDefinition {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "mt5",
        handler: async (params) => {
            const validated = params as MT5OrderParams
            return await prepareMT5Order(validated, pipeline, venue, policy, "adjustment")
        },
    })
}
