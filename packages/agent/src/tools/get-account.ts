import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import { createToolBinding } from "../tool-contracts"

export function createGetAccountTool(pipeline: ExecutionPipeline): ToolBinding {
    return createToolBinding({
        name: "get_account",
        handler: async () => {
            const account = await pipeline.getAccountState()
            return { account }
        },
    })
}
