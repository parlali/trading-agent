import { alpacaModifyOrderParamsSchema, createToolDefinition, defaultModifyOrderParamsSchema, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
export function createModifyOrderTool(pipeline, options = {}) {
    const isAlpacaOptions = options.mode === "alpaca-options";
    const paramsSchema = isAlpacaOptions
        ? alpacaModifyOrderParamsSchema
        : defaultModifyOrderParamsSchema;
    return createToolDefinition({
        name: "modify_order",
        venue: isAlpacaOptions ? "alpaca-options" : "polymarket",
        handler: async (params) => {
            const validated = params;
            const changes = {};
            if (validated.limitPrice !== undefined)
                changes.limitPrice = validated.limitPrice;
            if ("stopPrice" in validated && validated.stopPrice !== undefined) {
                changes.stopPrice = validated.stopPrice;
            }
            if (validated.quantity !== undefined)
                changes.quantity = validated.quantity;
            const result = await pipeline.modifyOrder(validated.orderId, changes, validated.reason);
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId);
            return toExecutionToolResult(result, { trackedOrder });
        },
    });
}
