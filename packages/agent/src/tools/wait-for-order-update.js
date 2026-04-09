import { createToolDefinition, } from "../tool-contracts";
export function createWaitForOrderUpdateTool(pipeline) {
    return createToolDefinition({
        name: "wait_for_order_update",
        handler: async (params) => {
            const validated = params;
            const snapshot = await pipeline.waitForOrderUpdate(validated.orderId, () => ({ decision: "wait" }), { timeoutMs: validated.timeoutMs });
            return {
                orderId: snapshot.orderId,
                action: snapshot.action,
                status: snapshot.status,
                quantity: snapshot.quantity,
                filledQuantity: snapshot.filledQuantity,
                remainingQuantity: snapshot.remainingQuantity,
                avgFillPrice: snapshot.avgFillPrice,
                updatedAt: snapshot.updatedAt,
                polling: snapshot.polling,
            };
        },
    });
}
