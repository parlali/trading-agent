import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import { createToolBinding } from "../tool-contracts"

export function createGetPositionsTool(pipeline: ExecutionPipeline): ToolBinding {
    return createToolBinding({
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
