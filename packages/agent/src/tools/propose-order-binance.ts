import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { BinancePolicy, ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    binanceOrderJsonSchema,
    binanceOrderParamsSchema,
    prepareBinanceOrder,
    type BinanceOrderParams,
} from "./binance-order-helpers"

export function createBinanceProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: BinanceVenueAdapter,
    policy: BinancePolicy
): ToolDefinition {
    return {
        name: "propose_order",
        description: [
            "Propose a Binance futures entry order for BTCUSDT/ETHUSDT.",
            "You must provide stopLoss and either takeProfit or riskRewardRatio.",
            "Position size is calculated automatically from maxRiskPercent and stop distance.",
            "Leverage defaults to policy maxLeverage and cannot exceed it.",
            "For filled entries, protective SL/TP orders are attached automatically.",
        ].join(" "),
        parameters: binanceOrderParamsSchema,
        jsonSchema: binanceOrderJsonSchema,
        handler: async (params) => {
            const validated = params as BinanceOrderParams
            return await prepareBinanceOrder(validated, pipeline, venue, policy, "entry")
        },
    }
}
