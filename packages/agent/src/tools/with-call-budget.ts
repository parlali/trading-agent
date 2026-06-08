import type { ToolBinding } from "../tool-registry"

export function withCallBudget(
    tool: ToolBinding,
    maxCalls: number
): ToolBinding {
    let callCount = 0

    return {
        ...tool,
        handler: async (params) => {
            callCount++
            if (callCount > maxCalls) {
                return {
                    error: `Budget exhausted: ${tool.name} has been called ${maxCalls} times this run. Use the information you already have to make your decision.`,
                }
            }
            return tool.handler(params)
        },
    }
}
