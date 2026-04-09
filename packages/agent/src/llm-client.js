import { retryWithBackoff } from "@valiq-trading/core";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 60 * 1000;
export class LLMClient {
    apiKey;
    model;
    baseUrl;
    controller = null;
    requestTimeoutMs;
    streamStallTimeoutMs;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.streamStallTimeoutMs = config.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS;
    }
    async chat(messages, tools, logger, maxRetries = 3) {
        return retryWithBackoff(() => this.doChat(messages, tools, logger), maxRetries, 2000);
    }
    cancel() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
    }
    async doChat(messages, tools, logger) {
        this.controller = new AbortController();
        const signal = this.controller.signal;
        const requestTimer = setTimeout(() => {
            this.controller?.abort();
        }, this.requestTimeoutMs);
        const body = {
            model: this.model,
            messages,
            stream: true,
        };
        if (tools && tools.length > 0) {
            body.tools = tools;
        }
        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://valiq.ai",
                    "X-Title": "Val-iQ Trading Agent",
                },
                body: JSON.stringify(body),
                signal,
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
            }
            return await this.processStream(response, logger);
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error("LLM request timed out or was cancelled");
            }
            throw error;
        }
        finally {
            clearTimeout(requestTimer);
            this.controller = null;
        }
    }
    async processStream(response, logger) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("No readable stream from OpenRouter response");
        }
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        const toolCallBuffer = {};
        const usage = {
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cost: 0,
        };
        let finishReason = "";
        try {
            while (true) {
                const readResult = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Stream stalled: no data received within timeout")), this.streamStallTimeoutMs)),
                ]);
                const { done, value } = readResult;
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === "" || trimmed === "data: [DONE]")
                        continue;
                    if (!trimmed.startsWith("data: "))
                        continue;
                    const jsonStr = trimmed.slice(6).trim();
                    let chunk;
                    try {
                        chunk = JSON.parse(jsonStr);
                    }
                    catch {
                        logger?.warn("Failed to parse SSE chunk", { raw: jsonStr });
                        continue;
                    }
                    if (chunk.usage) {
                        this.extractUsage(chunk.usage, usage);
                    }
                    const choice = chunk.choices?.[0];
                    if (!choice?.delta)
                        continue;
                    if (choice.delta.content) {
                        content += choice.delta.content;
                    }
                    if (choice.delta.tool_calls) {
                        for (const tc of choice.delta.tool_calls) {
                            if (tc.id) {
                                if (!toolCallBuffer[tc.id]) {
                                    toolCallBuffer[tc.id] = { id: tc.id, name: "", arguments: "" };
                                }
                                const entry = toolCallBuffer[tc.id];
                                if (entry && tc.function?.name) {
                                    entry.name += tc.function.name;
                                }
                                if (entry && tc.function?.arguments) {
                                    entry.arguments += tc.function.arguments;
                                }
                            }
                            else {
                                const ids = Object.keys(toolCallBuffer);
                                const lastId = ids[ids.length - 1];
                                const lastEntry = lastId ? toolCallBuffer[lastId] : undefined;
                                if (lastEntry) {
                                    if (tc.function?.name) {
                                        lastEntry.name += tc.function.name;
                                    }
                                    if (tc.function?.arguments) {
                                        lastEntry.arguments += tc.function.arguments;
                                    }
                                }
                            }
                        }
                    }
                    if (choice.finish_reason) {
                        finishReason = choice.finish_reason;
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        const toolCalls = Object.values(toolCallBuffer).map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
                name: tc.name,
                arguments: tc.arguments,
            },
        }));
        return {
            content: content || null,
            toolCalls,
            usage,
            finishReason,
        };
    }
    extractUsage(raw, target) {
        const promptTokens = (raw.prompt_tokens ?? raw.promptTokens ?? 0);
        const completionTokens = (raw.completion_tokens ?? raw.completionTokens ?? 0);
        const reasoningTokens = (raw.reasoning_tokens ?? raw.reasoningTokens ?? 0);
        const cost = (raw.cost ?? raw.total_cost ?? 0);
        if (promptTokens > target.promptTokens)
            target.promptTokens = promptTokens;
        if (completionTokens > target.completionTokens)
            target.completionTokens = completionTokens;
        if (reasoningTokens > target.reasoningTokens)
            target.reasoningTokens = reasoningTokens;
        if (cost > target.cost)
            target.cost = cost;
    }
}
