import { projectToolsForOpenRouter } from "../../tool-projections/openrouter"
import type { AgentModelProvider, AgentProviderRunArgs, AgentProviderRunResult } from "../types"
import {
    OpenRouterChatClient,
    type LLMUsage,
    type OpenRouterChatClientConfig,
} from "./openrouter-chat-client"

export interface OpenRouterAgentProviderConfig extends OpenRouterChatClientConfig {
    provider: "openrouter"
}

export class OpenRouterAgentProvider implements AgentModelProvider {
    readonly provider = "openrouter" as const
    private readonly client: OpenRouterChatClient
    private readonly model: string

    constructor(private readonly config: OpenRouterAgentProviderConfig) {
        this.client = new OpenRouterChatClient(config)
        this.model = config.model
    }

    async run(args: AgentProviderRunArgs): Promise<AgentProviderRunResult> {
        const {
            conversation,
            context,
            tools,
            toolEngine,
            logger,
            agentLogger,
            maxIterations,
            maxConsecutiveErrors,
            runStartedAt,
            runTimeoutMs,
        } = args
        const aggregatedUsage = createEmptyUsage()
        const openRouterTools = projectToolsForOpenRouter(tools.getAll())
        let consecutiveErrors = 0
        let iteration = 0

        while (iteration < maxIterations) {
            const elapsed = Date.now() - runStartedAt
            if (elapsed > runTimeoutMs) {
                logger.error("Agent run timed out", {
                    runId: context.runId,
                    elapsedMs: elapsed,
                    timeoutMs: runTimeoutMs,
                    iterations: iteration,
                })
                this.cancel()
                const lastContent = conversation.getLastAssistantContent()
                return this.result({
                    summary: lastContent ?? "Agent run timed out before producing a summary.",
                    error: `Run timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(runTimeoutMs / 1000)}s)`,
                    iterations: iteration,
                    usage: aggregatedUsage,
                })
            }

            if (args.killSwitchChecker) {
                try {
                    const killed = await args.killSwitchChecker()
                    if (killed) {
                        logger.warn("Kill switch activated mid-run -- stopping agent", {
                            runId: context.runId,
                            iteration,
                        })
                        this.cancel()
                        const lastContent = conversation.getLastAssistantContent()
                        return this.result({
                            summary: lastContent ?? "Agent stopped: kill switch activated.",
                            error: "Kill switch activated during run",
                            iterations: iteration,
                            usage: aggregatedUsage,
                        })
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
                response = await this.client.chat(
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
                    return this.result({
                        summary: "",
                        error: `Circuit breaker: ${consecutiveErrors} consecutive LLM failures. Last: ${errorMsg}`,
                        iterations: iteration,
                        usage: aggregatedUsage,
                    })
                }
                continue
            }

            addUsage(aggregatedUsage, response.usage)

            if (response.toolCalls.length > 0) {
                conversation.addAssistantMessage(response.content, response.toolCalls)

                void agentLogger?.log(
                    context.runId,
                    context.strategyId,
                    conversation.getSequence(),
                    "assistant",
                    response.content ?? ""
                )

                await toolEngine.executeOpenRouterBatch(response.toolCalls, {
                    onToolResult: async (result) => {
                        conversation.addToolResult(result.toolCallId, result.toolName, result.content)
                        await agentLogger?.log(
                            context.runId,
                            context.strategyId,
                            conversation.getSequence(),
                            "tool",
                            result.content,
                            result.toolName,
                            result.rawInput,
                            result.content
                        )
                    },
                    onUserMessage: async (content) => {
                        conversation.addUserMessage(content)
                        await agentLogger?.log(
                            context.runId,
                            context.strategyId,
                            conversation.getSequence(),
                            "user",
                            content
                        )
                    },
                })

                const fatalFault = toolEngine.getOutcome().fatalFault
                if (fatalFault) {
                    return this.result({
                        summary: "",
                        error: `Circuit breaker: ${fatalFault.reason} in run ${context.runId}: ${fatalFault.toolResult}`,
                        iterations: iteration,
                        usage: aggregatedUsage,
                    })
                }

                continue
            }

            if (response.content) {
                void agentLogger?.log(
                    context.runId,
                    context.strategyId,
                    conversation.getSequence(),
                    "assistant",
                    response.content
                )

                logger.info("Agent run complete", {
                    iterations: iteration,
                    runId: context.runId,
                    usage: aggregatedUsage,
                })

                return this.result({
                    summary: response.content,
                    iterations: iteration,
                    usage: aggregatedUsage,
                })
            }

            logger.warn("LLM returned empty response with no tool calls", { iteration })
            conversation.addAssistantMessage("")
            conversation.addUserMessage("Your last response was empty. Please continue your analysis or provide a summary.")
        }

        logger.warn("Agent hit max iterations", { maxIterations, runId: context.runId })

        const lastContent = conversation.getLastAssistantContent()
        return this.result({
            summary: lastContent ?? "Agent reached maximum iterations without producing a final summary.",
            error: `Reached max iterations (${maxIterations})`,
            iterations: iteration,
            usage: aggregatedUsage,
        })
    }

    cancel(): void {
        this.client.cancel()
    }

    private result(args: {
        summary: string
        error?: string
        iterations: number
        usage: LLMUsage
    }): AgentProviderRunResult {
        return {
            ...args,
            diagnostics: {
                provider: "openrouter",
                model: this.model,
                billingMode: "openrouter",
                responseIds: args.usage.responseIds,
            },
        }
    }
}

function createEmptyUsage(): LLMUsage {
    return {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cost: 0,
        responseIds: [],
    }
}

function addUsage(target: LLMUsage, usage: LLMUsage): void {
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
