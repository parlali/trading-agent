import { createToolDefinition, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
export function createMT5ModifyOrderTool(pipeline) {
    return createToolDefinition({
        name: "modify_order",
        venue: "mt5",
        handler: async (params) => {
            const validated = params;
            const changes = {
                metadata: {
                    stopLoss: validated.newStopLoss,
                    takeProfit: validated.newTakeProfit,
                },
            };
            const orderId = String(validated.orderId);
            const result = await pipeline.modifyOrder(orderId, changes, validated.reason);
            const trackedOrder = await pipeline.getOrderSnapshot(orderId);
            return toExecutionToolResult(result, { trackedOrder });
        },
    });
}
