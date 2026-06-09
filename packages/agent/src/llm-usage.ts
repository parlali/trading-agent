export interface LLMUsage {
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
    cost: number
    responseIds: string[]
}

export function createEmptyUsage(): LLMUsage {
    return {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cost: 0,
        responseIds: [],
    }
}

export function addUsage(target: LLMUsage, usage: LLMUsage): void {
    target.promptTokens += usage.promptTokens
    target.completionTokens += usage.completionTokens
    target.reasoningTokens += usage.reasoningTokens
    target.cost += usage.cost
    for (const responseId of usage.responseIds) {
        if (!target.responseIds.includes(responseId)) {
            target.responseIds.push(responseId)
        }
    }
}
