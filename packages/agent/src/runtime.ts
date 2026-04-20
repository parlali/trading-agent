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
    runTimeoutMs?: number
    agentLogger?: AgentMessageLogger
    cleanup?: Array<() => Promise<void>>
    killSwitchChecker?: () => Promise<boolean>
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
    degradedResearch?: {
        active: boolean
        reasons: string[]
        toolFailureCount: number
        retryCount: number
        decisionUnderDegradedContext: boolean
    }
}

const DEFAULT_MAX_ITERATIONS = 25
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000
const TOOL_TIMEOUT_MS = 120_000
const RESEARCH_TOOL_NAMES = new Set([
    "query_valiq_research",
    "query_valiq_data",
    "get_breaking_news",
    "web_search",
    "web_fetch",
])

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
        runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
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
    const runStartedAt = Date.now()

    const systemPrompt = buildSystemPrompt(context, tools.getDescriptions())
    conversation.addSystemMessage(systemPrompt)

    void agentLogger?.log(
        context.runId, context.strategyId,
        conversation.getSequence(), "system", systemPrompt
    )

    const userMessage = "Your positions and account state are already in the system prompt. Begin with the research steps defined in your strategy context, then decide on actions."

    conversation.addUserMessage(userMessage)

    void agentLogger?.log(
        context.runId, context.strategyId,
        conversation.getSequence(), "user",
        userMessage
    )

    let consecutiveErrors = 0
    let iteration = 0
    const repeatedToolErrors = new Map<string, number>()
    const maxRepeatedToolErrors = 3
    const degradedResearchReasons = new Set<string>()
    let degradedResearchToolFailureCount = 0
    let degradedResearchRetryCount = 0

    const openRouterTools = tools.toOpenRouterTools()

    const buildDegradedResearch = (decisionTaken: boolean) => ({
        active: degradedResearchReasons.size > 0,
        reasons: Array.from(degradedResearchReasons),
        toolFailureCount: degradedResearchToolFailureCount,
        retryCount: degradedResearchRetryCount,
        decisionUnderDegradedContext: decisionTaken && degradedResearchReasons.size > 0,
    })

    try {
        while (iteration < maxIterations) {
            const elapsed = Date.now() - runStartedAt
            if (elapsed > runTimeoutMs) {
                logger.error("Agent run timed out", {
                    runId: context.runId,
                    elapsedMs: elapsed,
                    timeoutMs: runTimeoutMs,
                    iterations: iteration,
                })
                client.cancel()
                const lastContent = conversation.getLastAssistantContent()
                return {
                    summary: lastContent ?? "Agent run timed out before producing a summary.",
                    error: `Run timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(runTimeoutMs / 1000)}s)`,
                    iterations: iteration,
                    usage: aggregatedUsage,
                    degradedResearch: buildDegradedResearch(false),
                }
            }

            if (config.killSwitchChecker) {
                try {
                    const killed = await config.killSwitchChecker()
                    if (killed) {
                        logger.warn("Kill switch activated mid-run -- stopping agent", {
                            runId: context.runId,
                            iteration,
                        })
                        client.cancel()
                        const lastContent = conversation.getLastAssistantContent()
                        return {
                            summary: lastContent ?? "Agent stopped: kill switch activated.",
                            error: "Kill switch activated during run",
                            iterations: iteration,
                            usage: aggregatedUsage,
                            degradedResearch: buildDegradedResearch(false),
                        }
                    }
                } catch (error) {
                    logger.warn("Kill switch check failed, continuing run", {
                        runId: context.runId,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }

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
                        degradedResearch: buildDegradedResearch(false),
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

                void agentLogger?.log(
                    context.runId, context.strategyId,
                    conversation.getSequence(), "assistant",
                    response.content ?? "",
                )

                const valid: Array<{
                    toolCall: typeof response.toolCalls[number]
                    toolDef: ReturnType<typeof tools.get> & {}
                    parsedArgs: unknown
                }> = []

                for (const toolCall of response.toolCalls) {
                    const toolName = toolCall.function.name
                    const toolDef = tools.get(toolName)

                    if (!toolDef) {
                        const errorResult = JSON.stringify({ error: `Unknown tool: ${toolName}` })
                        conversation.addToolResult(toolCall.id, toolName, errorResult)
                        logger.warn("Agent called unknown tool", { toolName })
                        void agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            errorResult, toolName, toolCall.function.arguments
                        )
                        const repeatedError = recordRepeatedToolError(repeatedToolErrors, toolName, errorResult)
                        if (repeatedError >= maxRepeatedToolErrors) {
                            if (RESEARCH_TOOL_NAMES.has(toolName)) {
                                degradedResearchToolFailureCount++
                                degradedResearchRetryCount += repeatedError
                                degradedResearchReasons.add(`${toolName}: unknown tool`)
                                clearRepeatedToolErrors(repeatedToolErrors, toolName)
                                conversation.addUserMessage(
                                    `System warning: ${toolName} is unavailable after repeated attempts. Continue in degraded research mode using currently available context and prioritize risk-reducing actions.`
                                )
                                continue
                            }
                            return repeatedToolErrorResult(context.runId, toolName, errorResult, iteration, aggregatedUsage)
                        }
                        continue
                    }

                    let parsedArgs: unknown
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments || "{}")
                    } catch {
                        const errorResult = JSON.stringify({ error: "Invalid JSON arguments" })
                        conversation.addToolResult(toolCall.id, toolName, errorResult)
                        logger.warn("Failed to parse tool arguments", { toolName, raw: toolCall.function.arguments })
                        void agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            errorResult, toolName, toolCall.function.arguments
                        )
                        const repeatedError = recordRepeatedToolError(repeatedToolErrors, toolName, errorResult)
                        if (repeatedError >= maxRepeatedToolErrors) {
                            if (RESEARCH_TOOL_NAMES.has(toolName)) {
                                degradedResearchToolFailureCount++
                                degradedResearchRetryCount += repeatedError
                                degradedResearchReasons.add(`${toolName}: invalid arguments loop`)
                                clearRepeatedToolErrors(repeatedToolErrors, toolName)
                                conversation.addUserMessage(
                                    `System warning: ${toolName} calls failed argument parsing repeatedly. Continue in degraded research mode and avoid repeated identical calls.`
                                )
                                continue
                            }
                            return repeatedToolErrorResult(context.runId, toolName, errorResult, iteration, aggregatedUsage)
                        }
                        continue
                    }

                    const validation = toolDef.parameters.safeParse(parsedArgs)
                    if (!validation.success) {
                        const errorResult = JSON.stringify({ error: "Parameter validation failed", details: validation.error })
                        conversation.addToolResult(toolCall.id, toolName, errorResult)
                        logger.warn("Tool parameter validation failed", { toolName, error: validation.error })
                        void agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            errorResult, toolName, toolCall.function.arguments
                        )
                        const repeatedError = recordRepeatedToolError(repeatedToolErrors, toolName, normalizeToolErrorSignature(errorResult))
                        if (repeatedError >= maxRepeatedToolErrors) {
                            if (RESEARCH_TOOL_NAMES.has(toolName)) {
                                degradedResearchToolFailureCount++
                                degradedResearchRetryCount += repeatedError
                                degradedResearchReasons.add(`${toolName}: parameter validation loop`)
                                clearRepeatedToolErrors(repeatedToolErrors, toolName)
                                conversation.addUserMessage(
                                    `System warning: ${toolName} parameter validation failed repeatedly. Continue in degraded research mode and proceed with bounded actions only.`
                                )
                                continue
                            }
                            return repeatedToolErrorResult(context.runId, toolName, errorResult, iteration, aggregatedUsage)
                        }
                        continue
                    }

                    valid.push({ toolCall, toolDef, parsedArgs: validation.data })
                }

                if (valid.length > 0) {
                    logger.info("Executing tools in parallel", {
                        tools: valid.map(v => v.toolCall.function.name),
                        count: valid.length,
                        runId: context.runId,
                    })

                    const remainingMs = runTimeoutMs - (Date.now() - runStartedAt)
                    const toolTimeoutMs = Math.max(Math.min(remainingMs, TOOL_TIMEOUT_MS), 5000)

                    const results = await Promise.allSettled(
                        valid.map(({ toolDef, parsedArgs }) =>
                            Promise.race([
                                toolDef.handler(parsedArgs),
                                new Promise<never>((_, reject) =>
                                    setTimeout(() => reject(new Error(`Tool timed out after ${Math.round(toolTimeoutMs / 1000)}s`)), toolTimeoutMs)
                                ),
                            ])
                        )
                    )

                    for (let i = 0; i < valid.length; i++) {
                        const entry = valid[i]!
                        const { toolCall } = entry
                        const toolName = toolCall.function.name
                        const result = results[i]!

                        let toolResult: string
                        if (result.status === "fulfilled") {
                            const val = (result as PromiseFulfilledResult<unknown>).value
                            toolResult = typeof val === "string" ? val : JSON.stringify(val)
                            clearRepeatedToolErrors(repeatedToolErrors, toolName)
                        } else {
                            const reason = (result as PromiseRejectedResult).reason
                            const errorMsg = reason instanceof Error ? reason.message : String(reason)
                            toolResult = JSON.stringify({ error: `Tool execution failed: ${errorMsg}` })
                            logger.error("Tool execution error", { toolName, error: errorMsg })
                            const repeatedError = recordRepeatedToolError(repeatedToolErrors, toolName, toolResult)
                            if (repeatedError >= maxRepeatedToolErrors) {
                                if (RESEARCH_TOOL_NAMES.has(toolName)) {
                                    degradedResearchToolFailureCount++
                                    degradedResearchRetryCount += repeatedError
                                    degradedResearchReasons.add(`${toolName}: execution failure loop`)
                                    clearRepeatedToolErrors(repeatedToolErrors, toolName)
                                    toolResult = JSON.stringify({
                                        warning: `Degraded research mode active: ${toolName} failed repeatedly and has been bounded for this run.`,
                                    })
                                } else {
                                    conversation.addToolResult(toolCall.id, toolName, toolResult)
                                    void agentLogger?.log(
                                        context.runId, context.strategyId,
                                        conversation.getSequence(), "tool",
                                        toolResult, toolName, toolCall.function.arguments, toolResult
                                    )
                                    return repeatedToolErrorResult(context.runId, toolName, toolResult, iteration, aggregatedUsage)
                                }
                            }
                        }

                        conversation.addToolResult(toolCall.id, toolName, toolResult)
                        void agentLogger?.log(
                            context.runId, context.strategyId,
                            conversation.getSequence(), "tool",
                            toolResult, toolName, toolCall.function.arguments, toolResult
                        )
                    }
                }

                continue
            }

            if (response.content) {
                void agentLogger?.log(
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
                    degradedResearch: buildDegradedResearch(true),
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
            degradedResearch: buildDegradedResearch(false),
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

function recordRepeatedToolError(
    repeatedToolErrors: Map<string, number>,
    toolName: string,
    errorResult: string
): number {
    const key = `${toolName}:${normalizeToolErrorSignature(errorResult)}`
    const count = (repeatedToolErrors.get(key) ?? 0) + 1
    repeatedToolErrors.set(key, count)
    return count
}

function clearRepeatedToolErrors(
    repeatedToolErrors: Map<string, number>,
    toolName: string
): void {
    for (const key of Array.from(repeatedToolErrors.keys())) {
        if (key.startsWith(`${toolName}:`)) {
            repeatedToolErrors.delete(key)
        }
    }
}

function normalizeToolErrorSignature(errorResult: string): string {
    return errorResult
        .replace(/"stack":"[^"]+"/g, "")
        .replace(/\d{4}-\d{2}-\d{2}T[^"]+/g, "timestamp")
        .slice(0, 1000)
}

function repeatedToolErrorResult(
    runId: string,
    toolName: string,
    toolResult: string,
    iteration: number,
    usage: LLMUsage
): AgentRunResult {
    return {
        summary: "",
        error: `Circuit breaker: repeated identical ${toolName} tool error in run ${runId}: ${toolResult}`,
        iterations: iteration,
        usage,
    }
}
