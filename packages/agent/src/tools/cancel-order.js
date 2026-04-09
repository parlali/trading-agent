import { createToolDefinition, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
export function createCancelOrderTool(pipeline) {
    return createToolDefinition({
        name: "cancel_order",
        handler: async (params) => {
            const validated = params;
            const result = await pipeline.cancelOrder(validated.orderId, validated.reason);
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId);
            return toExecutionToolResult(result, { trackedOrder });
        },
    });
}
