import type { StrategyRunContext, Logger } from "@valiq-trading/core"
import type { ToolRegistry } from "./tool-registry"
import { LLMClient } from "./llm-client"
import type { LLMClientConfig, LLMUsage } from "./llm-client"
import { ConversationManager } from "./conversation"
import { buildSystemPrompt } from "./prompt-builder"

export interface AgentRuntimeConfig {
    llm: LLMClientConfig
    tools: ToolRegistry
    logger: Logger
    maxIterations?: number
    maxConsecutiveErrors?: number
    agentLogger?: AgentMessageLogger
    cleanup?: Array<() => Promise<void>>
}

export interface AgentMessageLogger {
    log(
        runId: string,
        strategyId: string,
        sequence: number,
        role: string,
        content: string,
        toolName?: string,
        toolInput?: string,
        toolOutput?: string
    ): Promise<void>
}

export interface AgentRunResult {
    summary: string
    error?: string
    iterations: number
    usage: LLMUsage
}

const DEFAULT_MAX_ITERATIONS = 25
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5

export async function executeAgentRun(
    context: StrategyRunContext,
    config: AgentRuntimeConfig
): Promise<AgentRunResult> {
    const {
        llm: llmConfig,
        tools,
        logger,
        maxIterations = DEFAULT_MAX_ITERATIONS,
        maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
        agentLogger,
    } = config

    const client = new LLMClient(llmConfig)
    const conversation = new ConversationManager()
    const aggregatedUsage: LLMUsage = {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cost: 0,
    }

    const systemPrompt = buildSystemPrompt(context, tools.getDescriptions())
    conversation.addSystemMessage(systemPrompt)

    await agentLogger?.log(
        context.runId, context.strategyId,
        conversation.getSequence(), "system", systemPrompt
    )

    conversation.addUserMessage(
        "Begin your analysis. Check current market conditions and positions, then decide on actions."
    )

    await agentLogger?.log(
        context.runId, context.strategyId,
        conversation.getSequence(), "user",
        "Begin your analysis. Check current market conditions and positions, then decide on actions."
    )

    let consecutiveErrors = 0
    let iteration = 0

    const openRouterTools = tools.toOpenRouterTools()

    try {
        while (iteration < maxIterations) {
            iteration++
            logger.info("Agent iteration", { iteration, maxIterations, runId: context.runId })

            let response
            try {
                response = await client.chat(
                    conversation.getMessages(),
                    openRouterTools.length > 0 ? openRouterTools : undefined,
                    logger
                )
                consecutiveErrors = 0
            } catch (error) {
                consecutiveErrors++
                const errorMsg = error instanceof Error ? error.message : String(error)
                logger.error("LLM call failed", { error: errorMsg, attempt: consecutiveErrors, iteration })

                if (consecutiveErrors >= maxConsecutiveErrors) {
                    logger.fatal("Circuit breaker tripped", {
                        consecutiveErrors,
                        threshold: maxConsecutiveErrors,
                        runId: context.runId,
                    })
                    return {
                        summary: "",
                        error: `Circuit breaker: ${consecutiveErrors} consecutive LLM failures. Last: ${errorMsg}`,
                        iterations: iteration,
                        usage: aggregatedUsage,
                    }
                }
                continue
            }

            aggregatedUsage.promptTokens += response.usage.promptTokens
            aggregatedUsage.completionTokens += response.usage.completionTokens
            aggregatedUsage.reasoningTokens += response.usage.reasoningTokens
            aggregatedUsage.cost += response.usage.cost

            if (response.toolCalls.length > 0) {
                conversation.addAssistantMessage(response.content, response.toolCalls)

                await agentLogger?.log(
                    context.runId, context.strategyId,
                    conversation.getSequence(), "assistant",
                    response.content ?? "",
                )

                for (const toolCall of response.toolCalls) {
                    const toolName = toolCall.function.name
                    const toolDef = tools.get(toolName)

                    if (!toolDef) {
                        const errorResult = JSON.stringify({ error: `Unknown tool: ${toolName}` })
                        conversation.addToolResult(toolCall.id, toolName, errorResult)
                        logger.warn("Agent called unknown tool", { toolName })
                        await agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            errorResult, toolName, toolCall.function.arguments
                        )
                        continue
                    }

                    let parsedArgs: unknown
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments || "{}")
                    } catch {
                        const errorResult = JSON.stringify({ error: "Invalid JSON arguments" })
                        conversation.addToolResult(toolCall.id, toolName, errorResult)
                        logger.warn("Failed to parse tool arguments", { toolName, raw: toolCall.function.arguments })
                        await agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            errorResult, toolName, toolCall.function.arguments
                        )
                        continue
                    }

                    const validation = toolDef.parameters.safeParse(parsedArgs)
                    if (!validation.success) {
                        const errorResult = JSON.stringify({ error: "Parameter validation failed", details: validation.error })
                        conversation.addToolResult(toolCall.id, toolName, errorResult)
                        logger.warn("Tool parameter validation failed", { toolName, error: validation.error })
                        await agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            errorResult, toolName, toolCall.function.arguments
                        )
                        continue
                    }

                    let toolResult: string
                    try {
                        logger.info("Executing tool", { toolName, runId: context.runId })
                        const result = await toolDef.handler(validation.data)
                        toolResult = typeof result === "string" ? result : JSON.stringify(result)
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error)
                        toolResult = JSON.stringify({ error: `Tool execution failed: ${errorMsg}` })
                        logger.error("Tool execution error", { toolName, error: errorMsg })
                    }

                    conversation.addToolResult(toolCall.id, toolName, toolResult)
                    await agentLogger?.log(
                        context.runId, context.strategyId,
                        conversation.getSequence(), "tool",
                        toolResult, toolName, toolCall.function.arguments, toolResult
                    )
                }

                continue
            }

            if (response.content) {
                await agentLogger?.log(
                    context.runId, context.strategyId,
                    conversation.getSequence(), "assistant",
                    response.content
                )

                logger.info("Agent run complete", {
                    iterations: iteration,
                    runId: context.runId,
                    usage: aggregatedUsage,
                })

                return {
                    summary: response.content,
                    iterations: iteration,
                    usage: aggregatedUsage,
                }
            }

            logger.warn("LLM returned empty response with no tool calls", { iteration })
            conversation.addAssistantMessage("")
            conversation.addUserMessage("Your last response was empty. Please continue your analysis or provide a summary.")
        }

        logger.warn("Agent hit max iterations", { maxIterations, runId: context.runId })

        const lastContent = conversation.getLastAssistantContent()
        return {
            summary: lastContent ?? "Agent reached maximum iterations without producing a final summary.",
            error: `Reached max iterations (${maxIterations})`,
            iterations: iteration,
            usage: aggregatedUsage,
        }
    } finally {
        if (config.cleanup && config.cleanup.length > 0) {
            for (const cleanup of config.cleanup) {
                try {
                    await cleanup()
                } catch (error) {
                    logger.error("Agent cleanup failed", {
                        error: error instanceof Error ? error.message : String(error),
                        runId: context.runId,
                    })
                }
            }
        }
    }
}
