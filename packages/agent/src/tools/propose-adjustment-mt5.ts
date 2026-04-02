import type { ExecutionPipeline, MT5Policy } from "@valiq-trading/core"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import type { ToolDefinition } from "../tool-registry"
import {
    mt5OrderParamsSchema,
    mt5OrderJsonSchema,
    prepareMT5Order,
    type MT5OrderParams,
} from "./mt5-order-helpers"

export function createMT5ProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: MT5VenueAdapter,
    policy: MT5Policy
): ToolDefinition {
    return {
        name: "propose_adjustment",
        description: [
            "Propose adjusting an existing MT5 position by adding to it.",
            "You must provide stopLoss (absolute price) and either takeProfit (absolute price) or riskRewardRatio (e.g. 2.0), not both.",
            "Position size is calculated automatically so that hitting your stop-loss loses exactly maxRiskPercent of account balance.",
            "Do NOT specify quantity/lot size -- it is computed for you.",
            "Include a reason for the adjustment.",
        ].join(" "),
        parameters: mt5OrderParamsSchema,
        jsonSchema: mt5OrderJsonSchema,
        handler: async (params) => {
            const validated = params as MT5OrderParams
            return await prepareMT5Order(validated, pipeline, venue, policy, "adjustment")
        },
    }
}
