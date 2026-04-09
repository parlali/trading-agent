import { createToolDefinition } from "../tool-contracts";
import { prepareBinanceOrder, } from "./binance-order-helpers";
export function createBinanceProposeOrderTool(pipeline, venue, policy) {
    return createToolDefinition({
        name: "propose_order",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params;
            return await prepareBinanceOrder(validated, pipeline, venue, policy, "entry");
        },
    });
}
