import { LLMClient } from "./llm-client";
import { ConversationManager } from "./conversation";
import { buildSystemPrompt } from "./prompt-builder";
const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_TIMEOUT_MS = 120_000;
export async function executeAgentRun(context, config) {
    const { llm: llmConfig, tools, logger, maxIterations = DEFAULT_MAX_ITERATIONS, maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS, runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS, agentLogger, } = config;
    const client = new LLMClient(llmConfig);
    const conversation = new ConversationManager();
    const aggregatedUsage = {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cost: 0,
    };
    const runStartedAt = Date.now();
    const systemPrompt = buildSystemPrompt(context, tools.getDescriptions());
    conversation.addSystemMessage(systemPrompt);
    void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "system", systemPrompt);
    const userMessage = "Your positions and account state are already in the system prompt. Begin with the research steps defined in your strategy context, then decide on actions.";
    conversation.addUserMessage(userMessage);
    void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "user", userMessage);
    let consecutiveErrors = 0;
    let iteration = 0;
    const openRouterTools = tools.toOpenRouterTools();
    try {
        while (iteration < maxIterations) {
            const elapsed = Date.now() - runStartedAt;
            if (elapsed > runTimeoutMs) {
                logger.error("Agent run timed out", {
                    runId: context.runId,
                    elapsedMs: elapsed,
                    timeoutMs: runTimeoutMs,
                    iterations: iteration,
                });
                client.cancel();
                const lastContent = conversation.getLastAssistantContent();
                return {
                    summary: lastContent ?? "Agent run timed out before producing a summary.",
                    error: `Run timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(runTimeoutMs / 1000)}s)`,
                    iterations: iteration,
                    usage: aggregatedUsage,
                };
            }
            if (config.killSwitchChecker) {
                try {
                    const killed = await config.killSwitchChecker();
                    if (killed) {
                        logger.warn("Kill switch activated mid-run -- stopping agent", {
                            runId: context.runId,
                            iteration,
                        });
                        client.cancel();
                        const lastContent = conversation.getLastAssistantContent();
                        return {
                            summary: lastContent ?? "Agent stopped: kill switch activated.",
                            error: "Kill switch activated during run",
                            iterations: iteration,
                            usage: aggregatedUsage,
                        };
                    }
                }
                catch (error) {
                    logger.warn("Kill switch check failed, continuing run", {
                        runId: context.runId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            iteration++;
            logger.info("Agent iteration", { iteration, maxIterations, runId: context.runId });
            let response;
            try {
                response = await client.chat(conversation.getMessages(), openRouterTools.length > 0 ? openRouterTools : undefined, logger);
                consecutiveErrors = 0;
            }
            catch (error) {
                consecutiveErrors++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error("LLM call failed", { error: errorMsg, attempt: consecutiveErrors, iteration });
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    logger.fatal("Circuit breaker tripped", {
                        consecutiveErrors,
                        threshold: maxConsecutiveErrors,
                        runId: context.runId,
                    });
                    return {
                        summary: "",
                        error: `Circuit breaker: ${consecutiveErrors} consecutive LLM failures. Last: ${errorMsg}`,
                        iterations: iteration,
                        usage: aggregatedUsage,
                    };
                }
                continue;
            }
            aggregatedUsage.promptTokens += response.usage.promptTokens;
            aggregatedUsage.completionTokens += response.usage.completionTokens;
            aggregatedUsage.reasoningTokens += response.usage.reasoningTokens;
            aggregatedUsage.cost += response.usage.cost;
            if (response.toolCalls.length > 0) {
                conversation.addAssistantMessage(response.content, response.toolCalls);
                void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "assistant", response.content ?? "");
                const valid = [];
                for (const toolCall of response.toolCalls) {
                    const toolName = toolCall.function.name;
                    const toolDef = tools.get(toolName);
                    if (!toolDef) {
                        const errorResult = JSON.stringify({ error: `Unknown tool: ${toolName}` });
                        conversation.addToolResult(toolCall.id, toolName, errorResult);
                        logger.warn("Agent called unknown tool", { toolName });
                        void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "tool", errorResult, toolName, toolCall.function.arguments);
                        continue;
                    }
                    let parsedArgs;
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
                    }
                    catch {
                        const errorResult = JSON.stringify({ error: "Invalid JSON arguments" });
                        conversation.addToolResult(toolCall.id, toolName, errorResult);
                        logger.warn("Failed to parse tool arguments", { toolName, raw: toolCall.function.arguments });
                        void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "tool", errorResult, toolName, toolCall.function.arguments);
                        continue;
                    }
                    const validation = toolDef.parameters.safeParse(parsedArgs);
                    if (!validation.success) {
                        const errorResult = JSON.stringify({ error: "Parameter validation failed", details: validation.error });
                        conversation.addToolResult(toolCall.id, toolName, errorResult);
                        logger.warn("Tool parameter validation failed", { toolName, error: validation.error });
                        void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "tool", errorResult, toolName, toolCall.function.arguments);
                        continue;
                    }
                    valid.push({ toolCall, toolDef, parsedArgs: validation.data });
                }
                if (valid.length > 0) {
                    logger.info("Executing tools in parallel", {
                        tools: valid.map(v => v.toolCall.function.name),
                        count: valid.length,
                        runId: context.runId,
                    });
                    const remainingMs = runTimeoutMs - (Date.now() - runStartedAt);
                    const toolTimeoutMs = Math.max(Math.min(remainingMs, TOOL_TIMEOUT_MS), 5000);
                    const results = await Promise.allSettled(valid.map(({ toolDef, parsedArgs }) => Promise.race([
                        toolDef.handler(parsedArgs),
                        new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool timed out after ${Math.round(toolTimeoutMs / 1000)}s`)), toolTimeoutMs)),
                    ])));
                    for (let i = 0; i < valid.length; i++) {
                        const entry = valid[i];
                        const { toolCall } = entry;
                        const toolName = toolCall.function.name;
                        const result = results[i];
                        let toolResult;
                        if (result.status === "fulfilled") {
                            const val = result.value;
                            toolResult = typeof val === "string" ? val : JSON.stringify(val);
                        }
                        else {
                            const reason = result.reason;
                            const errorMsg = reason instanceof Error ? reason.message : String(reason);
                            toolResult = JSON.stringify({ error: `Tool execution failed: ${errorMsg}` });
                            logger.error("Tool execution error", { toolName, error: errorMsg });
                        }
                        conversation.addToolResult(toolCall.id, toolName, toolResult);
                        void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "tool", toolResult, toolName, toolCall.function.arguments, toolResult);
                    }
                }
                continue;
            }
            if (response.content) {
                void agentLogger?.log(context.runId, context.strategyId, conversation.getSequence(), "assistant", response.content);
                logger.info("Agent run complete", {
                    iterations: iteration,
                    runId: context.runId,
                    usage: aggregatedUsage,
                });
                return {
                    summary: response.content,
                    iterations: iteration,
                    usage: aggregatedUsage,
                };
            }
            logger.warn("LLM returned empty response with no tool calls", { iteration });
            conversation.addAssistantMessage("");
            conversation.addUserMessage("Your last response was empty. Please continue your analysis or provide a summary.");
        }
        logger.warn("Agent hit max iterations", { maxIterations, runId: context.runId });
        const lastContent = conversation.getLastAssistantContent();
        return {
            summary: lastContent ?? "Agent reached maximum iterations without producing a final summary.",
            error: `Reached max iterations (${maxIterations})`,
            iterations: iteration,
            usage: aggregatedUsage,
        };
    }
    finally {
        if (config.cleanup && config.cleanup.length > 0) {
            for (const cleanup of config.cleanup) {
                try {
                    await cleanup();
                }
                catch (error) {
                    logger.error("Agent cleanup failed", {
                        error: error instanceof Error ? error.message : String(error),
                        runId: context.runId,
                    });
                }
            }
        }
    }
}
