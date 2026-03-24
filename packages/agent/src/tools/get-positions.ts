import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

export function createGetPositionsTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "get_positions",
        description: "Get all current open positions. Returns instrument, side, quantity, entry price, current price, and unrealized P&L for each position.",
        parameters: z.object({}),
        jsonSchema: {
            type: "object",
            properties: {},
        },
        handler: async () => {
            const positions = await pipeline.getPositions()
            if (positions.length === 0) {
                return { positions: [], message: "No open positions" }
            }
            return { positions }
        },
    }
}
