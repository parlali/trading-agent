import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

export function createGetAccountTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "get_account",
        description: "Get current account state including balance, buying power, margin usage, and P&L.",
        parameters: z.object({}),
        jsonSchema: {
            type: "object",
            properties: {},
        },
        handler: async () => {
            const account = await pipeline.getAccountState()
            return { account }
        },
    }
}
