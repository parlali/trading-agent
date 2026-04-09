import { createToolDefinition, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
import { resolveEstimatedPrice } from "./polymarket-order-helpers";
export function createPolymarketProposeAdjustmentTool(pipeline, venue) {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params;
            const [positions, account] = await Promise.all([
                pipeline.getPositions(),
                pipeline.getAccountState(),
            ]);
            const estimatedPrice = await resolveEstimatedPrice(venue, validated.instrument, validated.side, validated.limitPrice);
            const intent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: validated.stopPrice,
                timeInForce: validated.timeInForce,
                metadata: {
                    action: "adjustment",
                    reason: validated.reason,
                    estimatedPrice,
                },
            };
            const { result, validation } = await pipeline.executeIntent(intent, account, positions, { action: "adjustment" });
            return toExecutionToolResult(result, { validation });
        },
    });
}
