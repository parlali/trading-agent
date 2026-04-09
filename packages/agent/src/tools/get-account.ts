import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { createToolDefinition } from "../tool-contracts"

export function createGetAccountTool(pipeline: ExecutionPipeline): ToolDefinition {
    return createToolDefinition({
        name: "get_account",
        handler: async () => {
            const account = await pipeline.getAccountState()
            return { account }
        },
    })
}
