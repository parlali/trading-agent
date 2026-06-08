import { projectToolsForOpenRouter } from "../../tool-projections/openrouter"
import type {
    AgentModelProvider,
    AgentProviderRunArgs,
    AgentProviderRunResult,
} from "../types"
import {
    OpenRouterChatClient,
    type LLMUsage,
    type OpenRouterChatClientConfig,
} from "./openrouter-chat-client"

export interface OpenRouterAgentProviderConfig extends OpenRouterChatClientConfig {
    provider: "openrouter"
}

const KILL_SWITCH_POLL_MS = 1000

export class OpenRouterAgentProvider implements AgentModelProvider {
    readonly provider = "openrouter" as const
    private readonly client: OpenRouterChatClient
    private readonly model: string
    private activeRunController: AbortController | undefined

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
        let killSwitchActivated = false
        const runController = new AbortController()
        this.activeRunController = runController

        const stopForKillSwitch = () => {
            if (!killSwitchActivated) {
                killSwitchActivated = true
                logger.warn("Kill switch activated mid-run -- stopping agent", {
                    runId: context.runId,
                    iteration,
                })
            }
            runController.abort()
            this.client.cancel()
        }

        const killSwitchResult = () =>
            this.result({
                summary:
                    conversation.getLastAssistantContent() ??
                    "Agent stopped: kill switch activated.",
                error: "Kill switch activated during run",
                iterations: iteration,
                usage: aggregatedUsage,
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
                    this.cancel()
                    const lastContent = conversation.getLastAssistantContent()
                    return this.result({
                        summary:
                            lastContent ??
                            "Agent run timed out before producing a summary.",
                        error: `Run timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(runTimeoutMs / 1000)}s)`,
                        iterations: iteration,
                        usage: aggregatedUsage,
                    })
                }

                if (args.killSwitchChecker) {
                    try {
                        const killed = await args.killSwitchChecker()
                        if (killed) {
                            stopForKillSwitch()
                            return killSwitchResult()
                        }
                    } catch (error) {
                        logger.warn(
                            "Kill switch check failed, continuing run",
                            {
                                runId: context.runId,
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            },
                        )
                    }
                }

                iteration++
                logger.info("Agent iteration", {
                    iteration,
                    maxIterations,
                    runId: context.runId,
                })

                let response
                try {
                    response = await this.runWithKillSwitchPolling(
                        async () =>
                            await this.client.chat(
                                conversation.getMessages(),
                                openRouterTools.length > 0
                                    ? openRouterTools
                                    : undefined,
                                logger,
                                3,
                                runController.signal,
                            ),
                        args,
                        stopForKillSwitch,
                        runController.signal,
                    )
                    consecutiveErrors = 0
                } catch (error) {
                    if (runController.signal.aborted) {
                        return killSwitchActivated
                            ? killSwitchResult()
                            : this.result({
                                  summary:
                                      conversation.getLastAssistantContent() ??
                                      "Agent run was cancelled.",
                                  error: "Agent run cancelled",
                                  iterations: iteration,
                                  usage: aggregatedUsage,
                              })
                    }
                    consecutiveErrors++
                    const errorMsg =
                        error instanceof Error ? error.message : String(error)
                    logger.error("LLM call failed", {
                        error: errorMsg,
                        attempt: consecutiveErrors,
                        iteration,
                    })

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
                    conversation.addAssistantMessage(
                        response.content,
                        response.toolCalls,
                    )

                    await this.logAgentMessage(
                        context.runId,
                        context.strategyId,
                        conversation.getSequence(),
                        "assistant",
                        response.content ?? "",
                        agentLogger,
                        logger,
                    )

                    try {
                        await this.runWithKillSwitchPolling(
                            async () =>
                                await toolEngine.executeOpenRouterBatch(
                                    response.toolCalls,
                                    {
                                        onToolResult: async (result) => {
                                            conversation.addToolResult(
                                                result.toolCallId,
                                                result.toolName,
                                                result.content,
                                            )
                                            await agentLogger?.log(
                                                context.runId,
                                                context.strategyId,
                                                conversation.getSequence(),
                                                "tool",
                                                result.content,
                                                result.toolName,
                                                result.rawInput,
                                                result.content,
                                            )
                                        },
                                        onUserMessage: async (content) => {
                                            conversation.addUserMessage(content)
                                            await agentLogger?.log(
                                                context.runId,
                                                context.strategyId,
                                                conversation.getSequence(),
                                                "user",
                                                content,
                                            )
                                        },
                                    },
                                    {
                                        signal: runController.signal,
                                    },
                                ),
                            args,
                            stopForKillSwitch,
                            runController.signal,
                        )
                    } catch (error) {
                        if (runController.signal.aborted) {
                            return killSwitchActivated
                                ? killSwitchResult()
                                : this.result({
                                      summary:
                                          conversation.getLastAssistantContent() ??
                                          "Agent run was cancelled.",
                                      error: "Agent run cancelled",
                                      iterations: iteration,
                                      usage: aggregatedUsage,
                                  })
                        }
                        throw error
                    }

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
                    await this.logAgentMessage(
                        context.runId,
                        context.strategyId,
                        conversation.getSequence(),
                        "assistant",
                        response.content,
                        agentLogger,
                        logger,
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

                logger.warn("LLM returned empty response with no tool calls", {
                    iteration,
                })
                conversation.addAssistantMessage("")
                await this.logAgentMessage(
                    context.runId,
                    context.strategyId,
                    conversation.getSequence(),
                    "assistant",
                    "",
                    agentLogger,
                    logger,
                )
                conversation.addUserMessage(
                    "Your last response was empty. Please continue your analysis or provide a summary.",
                )
                await this.logAgentMessage(
                    context.runId,
                    context.strategyId,
                    conversation.getSequence(),
                    "user",
                    "Your last response was empty. Please continue your analysis or provide a summary.",
                    agentLogger,
                    logger,
                )
            }

            logger.warn("Agent hit max iterations", {
                maxIterations,
                runId: context.runId,
            })

            const lastContent = conversation.getLastAssistantContent()
            return this.result({
                summary:
                    lastContent ??
                    "Agent reached maximum iterations without producing a final summary.",
                error: `Reached max iterations (${maxIterations})`,
                iterations: iteration,
                usage: aggregatedUsage,
            })
        } finally {
            if (this.activeRunController === runController) {
                this.activeRunController = undefined
            }
        }
    }

    cancel(): void {
        this.activeRunController?.abort()
        this.client.cancel()
    }

    private async runWithKillSwitchPolling<T>(
        operation: () => Promise<T>,
        args: AgentProviderRunArgs,
        stopForKillSwitch: () => void,
        signal: AbortSignal,
    ): Promise<T> {
        if (!args.killSwitchChecker) {
            return await operation()
        }

        let stopped = false
        const poll = async (pollSignal: AbortSignal) => {
            while (!stopped && !signal.aborted && !pollSignal.aborted) {
                try {
                    await delay(KILL_SWITCH_POLL_MS, pollSignal)
                } catch {
                    return
                }
                if (stopped || signal.aborted || pollSignal.aborted) {
                    return
                }
                try {
                    if (await args.killSwitchChecker?.()) {
                        stopForKillSwitch()
                        return
                    }
                } catch (error) {
                    args.logger.warn(
                        "Kill switch check failed during in-flight operation",
                        {
                            runId: args.context.runId,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    )
                }
            }
        }

        const pollingController = new AbortController()
        const pollPromise = poll(pollingController.signal)
        try {
            return await operation()
        } finally {
            stopped = true
            pollingController.abort()
            await pollPromise
        }
    }

    private async logAgentMessage(
        runId: string,
        strategyId: string,
        sequence: number,
        role: "assistant" | "user",
        content: string,
        agentLogger: AgentProviderRunArgs["agentLogger"],
        logger: AgentProviderRunArgs["logger"],
    ): Promise<void> {
        try {
            await agentLogger?.log(runId, strategyId, sequence, role, content)
        } catch (error) {
            logger.error("Agent transcript write failed", {
                runId,
                role,
                error: error instanceof Error ? error.message : String(error),
            })
        }
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

function delay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(new Error("cancelled"))
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        }, delayMs)
        const onAbort = () => {
            clearTimeout(timer)
            reject(new Error("cancelled"))
        }
        signal.addEventListener("abort", onAbort, { once: true })
    })
}
