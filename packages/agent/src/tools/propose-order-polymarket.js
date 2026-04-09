import { createToolDefinition, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
import { resolveEstimatedPrice } from "./polymarket-order-helpers";
export function createPolymarketProposeOrderTool(pipeline, venue) {
    return createToolDefinition({
        name: "propose_order",
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
                legs: validated.legs,
                metadata: {
                    ...validated.metadata,
                    estimatedPrice,
                },
            };
            const { result, validation, handle } = await pipeline.executeIntent(intent, account, positions, {
                action: "entry",
            });
            return toExecutionToolResult(result, {
                trackedOrder: handle?.snapshot,
                validation,
            });
        },
    });
}
