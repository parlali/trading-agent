import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { BinancePolicy, ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { createToolDefinition } from "../tool-contracts"
import {
    prepareBinanceOrder,
    type BinanceOrderParams,
} from "./binance-order-helpers"

export function createBinanceProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: BinanceVenueAdapter,
    policy: BinancePolicy
): ToolDefinition {
    return createToolDefinition({
        name: "propose_order",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params as BinanceOrderParams
            return await prepareBinanceOrder(validated, pipeline, venue, policy, "entry")
        },
    })
}
