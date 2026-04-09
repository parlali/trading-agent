import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { createToolDefinition } from "../tool-contracts"

export function createGetPositionsTool(pipeline: ExecutionPipeline): ToolDefinition {
    return createToolDefinition({
        name: "get_positions",
        handler: async () => {
            const positions = await pipeline.getPositions()
            if (positions.length === 0) {
                return { positions: [], message: "No open positions" }
            }
            return { positions }
        },
    })
}
