import { createToolDefinition } from "../tool-contracts";
import { prepareMT5Order, } from "./mt5-order-helpers";
export function createMT5ProposeAdjustmentTool(pipeline, venue, policy) {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "mt5",
        handler: async (params) => {
            const validated = params;
            return await prepareMT5Order(validated, pipeline, venue, policy, "adjustment");
        },
    });
}
