import type { ToolBinding } from "../tool-registry"

export function withCallBudget(
    tool: ToolBinding,
    maxCalls: number
): ToolBinding {
    const callCounts = new Map<string, number>()

    return {
        ...tool,
        handler: async (params, context) => {
            const budgetKey = tool.callBudgetKey?.(params) ?? tool.name
            const callCount = (callCounts.get(budgetKey) ?? 0) + 1
            callCounts.set(budgetKey, callCount)
            if (callCount > maxCalls) {
                return {
                    isError: true,
                    error: `Budget exhausted: ${tool.name} has been called ${maxCalls} times for ${budgetKey}. Use the information you already have to make your decision.`,
                }
            }
            return tool.handler(params, context)
        },
    }
}
