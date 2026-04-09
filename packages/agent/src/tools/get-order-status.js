import { createExecutionErrorDetail, formatExecutionError, getErrorMessage, getExecutionErrorDetail, } from "@valiq-trading/core";
import { createToolDefinition, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
export function createGetOrderStatusTool(pipeline) {
    return createToolDefinition({
        name: "get_order_status",
        handler: async (params) => {
            const validated = params;
            try {
                const result = await pipeline.getOrderStatus(validated.orderId);
                const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId);
                return toExecutionToolResult(result, { trackedOrder });
            }
            catch (error) {
                const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error));
                return {
                    orderId: validated.orderId,
                    status: "unknown",
                    error: formatExecutionError(errorDetail),
                    errorDetail,
                };
            }
        },
    });
}
