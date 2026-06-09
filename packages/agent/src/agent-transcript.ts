import type { AgentMessageLogger, Logger } from "@valiq-trading/core"
import type { ToolCall } from "./llm-client"

export async function safeLogAgentMessage(args: {
    agentLogger?: AgentMessageLogger
    logger: Logger
    runId: string
    strategyId: string
    sequence: number
    role: string
    content: string
    toolName?: string
    toolInput?: string
    toolOutput?: string
    toolCalls?: string
}): Promise<void> {
    try {
        await args.agentLogger?.log(
            args.runId,
            args.strategyId,
            args.sequence,
            args.role,
            args.content,
            args.toolName,
            args.toolInput,
            args.toolOutput,
            args.toolCalls
        )
    } catch (error) {
        args.logger.error("Agent transcript write failed", {
            runId: args.runId,
            role: args.role,
            toolName: args.toolName,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

export function serializeToolCallsForTranscript(toolCalls: ToolCall[]): string {
    return JSON.stringify(
        toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: toolCall.type,
            function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
            },
        })),
        null,
        2
    )
}
