import { projectToolsForOpenRouter } from "../../tool-projections/openrouter"
import { safeLogAgentMessage, serializeToolCallsForTranscript } from "../../agent-transcript"
import { addUsage, createEmptyUsage, type LLMUsage } from "../../llm-usage"
import type {
    AgentModelProvider,
    AgentProviderRunArgs,
    AgentProviderRunResult,
} from "../types"
import {
    OpenRouterChatClient,
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
        let killSwitchFailure: string | undefined

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

        const stopForKillSwitchFailure = (error: unknown) => {
            killSwitchFailure = error instanceof Error ? error.message : String(error)
            logger.error("Kill switch check failed, stopping agent", {
                runId: context.runId,
                iteration,
                error: killSwitchFailure,
            })
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

        const stoppedRunResult = () => {
            if (killSwitchFailure) {
                return this.result({
                    summary:
                        conversation.getLastAssistantContent() ??
                        "Agent stopped: kill switch check failed.",
                    error: `Kill switch check failed: ${killSwitchFailure}`,
                    iterations: iteration,
                    usage: aggregatedUsage,
                })
            }

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
                        stopForKillSwitchFailure(error)
                        return stoppedRunResult()
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
                        stopForKillSwitchFailure,
                        runController.signal,
                    )
                    consecutiveErrors = 0
                } catch (error) {
                    if (runController.signal.aborted) {
                        return stoppedRunResult()
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

                    await safeLogAgentMessage({
                        agentLogger,
                        logger,
                        runId: context.runId,
                        strategyId: context.strategyId,
                        sequence: conversation.getSequence(),
                        role: "assistant",
                        content: response.content ?? "",
                        toolCalls: serializeToolCallsForTranscript(response.toolCalls),
                    })

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
                                            await safeLogAgentMessage({
                                                agentLogger,
                                                logger,
                                                runId: context.runId,
                                                strategyId: context.strategyId,
                                                sequence: conversation.getSequence(),
                                                role: "tool",
                                                content: result.content,
                                                toolName: result.toolName,
                                                toolInput: result.rawInput,
                                                toolOutput: result.content,
                                            })
                                        },
                                        onUserMessage: async (content) => {
                                            conversation.addUserMessage(content)
                                            await safeLogAgentMessage({
                                                agentLogger,
                                                logger,
                                                runId: context.runId,
                                                strategyId: context.strategyId,
                                                sequence: conversation.getSequence(),
                                                role: "user",
                                                content,
                                            })
                                        },
                                    },
                                    {
                                        signal: runController.signal,
                                    },
                                ),
                            args,
                            stopForKillSwitch,
                            stopForKillSwitchFailure,
                            runController.signal,
                        )
                    } catch (error) {
                        if (runController.signal.aborted) {
                            return stoppedRunResult()
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
                    conversation.addAssistantMessage(response.content)
                    await safeLogAgentMessage({
                        agentLogger,
                        logger,
                        runId: context.runId,
                        strategyId: context.strategyId,
                        sequence: conversation.getSequence(),
                        role: "assistant",
                        content: response.content,
                    })

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
                await safeLogAgentMessage({
                    agentLogger,
                    logger,
                    runId: context.runId,
                    strategyId: context.strategyId,
                    sequence: conversation.getSequence(),
                    role: "assistant",
                    content: "",
                })
                conversation.addUserMessage(
                    "Your last response was empty. Please continue your analysis or provide a summary.",
                )
                await safeLogAgentMessage({
                    agentLogger,
                    logger,
                    runId: context.runId,
                    strategyId: context.strategyId,
                    sequence: conversation.getSequence(),
                    role: "user",
                    content: "Your last response was empty. Please continue your analysis or provide a summary.",
                })
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
        stopForKillSwitchFailure: (error: unknown) => void,
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
                    stopForKillSwitchFailure(error)
                    return
                }
            }
        }

        const pollingController = new AbortController()
        const pollPromise = poll(pollingController.signal)
        try {
            const result = await operation()
            if (signal.aborted) {
                throw createAbortError("Agent run cancelled")
            }
            return result
        } finally {
            stopped = true
            pollingController.abort()
            await pollPromise
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

function createAbortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
