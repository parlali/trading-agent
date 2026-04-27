import { retryWithBackoff } from "@valiq-trading/core"
import type { Logger } from "@valiq-trading/core"

export interface LLMClientConfig {
    apiKey: string
    model: string
    reasoning?: OpenRouterReasoningConfig
    baseUrl?: string
    requestTimeoutMs?: number
    streamStallTimeoutMs?: number
}

export interface OpenRouterReasoningConfig {
    effort: "low" | "medium" | "high"
    exclude?: boolean
}

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool"
    content: string | null
    tool_calls?: ToolCall[]
    tool_call_id?: string
    name?: string
}

export interface ToolCall {
    id: string
    type: "function"
    function: {
        name: string
        arguments: string
    }
}

export interface OpenRouterTool {
    type: "function"
    function: {
        name: string
        description: string
        parameters: Record<string, unknown>
    }
}

export interface LLMUsage {
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
    cost: number
}

export interface LLMResponse {
    content: string | null
    toolCalls: ToolCall[]
    usage: LLMUsage
    finishReason: string
}

interface StreamChunk {
    choices?: Array<{
        delta?: {
            content?: string | null
            tool_calls?: Array<{
                id?: string
                type?: string
                function?: { name?: string; arguments?: string }
            }>
        }
        finish_reason?: string | null
    }>
    usage?: Record<string, unknown>
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 60 * 1000

export class LLMClient {
    private apiKey: string
    private model: string
    private reasoning?: OpenRouterReasoningConfig
    private baseUrl: string
    private controller: AbortController | null = null
    private requestTimeoutMs: number
    private streamStallTimeoutMs: number

    constructor(config: LLMClientConfig) {
        this.apiKey = config.apiKey
        this.model = config.model
        this.reasoning = config.reasoning
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
        this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        this.streamStallTimeoutMs = config.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS
    }

    async chat(
        messages: ChatMessage[],
        tools?: OpenRouterTool[],
        logger?: Logger,
        maxRetries = 3
    ): Promise<LLMResponse> {
        return retryWithBackoff(
            () => this.doChat(messages, tools, logger),
            maxRetries,
            2000
        )
    }

    cancel(): void {
        if (this.controller) {
            this.controller.abort()
            this.controller = null
        }
    }

    private async doChat(
        messages: ChatMessage[],
        tools?: OpenRouterTool[],
        logger?: Logger
    ): Promise<LLMResponse> {
        this.controller = new AbortController()
        const signal = this.controller.signal

        const requestTimer = setTimeout(() => {
            this.controller?.abort()
        }, this.requestTimeoutMs)

        const body: Record<string, unknown> = {
            model: this.model,
            messages,
            stream: true,
        }

        if (this.reasoning) {
            body.reasoning = {
                effort: this.reasoning.effort,
                exclude: this.reasoning.exclude !== false,
            }
        }

        if (tools && tools.length > 0) {
            body.tools = tools
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
            })

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`)
            }

            return await this.processStream(response, logger)
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error("LLM request timed out or was cancelled")
            }
            throw error
        } finally {
            clearTimeout(requestTimer)
            this.controller = null
        }
    }

    private async processStream(response: Response, logger?: Logger): Promise<LLMResponse> {
        const reader = response.body?.getReader()
        if (!reader) {
            throw new Error("No readable stream from OpenRouter response")
        }

        const decoder = new TextDecoder()
        let buffer = ""
        let content = ""
        const toolCallBuffer: Record<string, { id: string; name: string; arguments: string }> = {}
        const usage: LLMUsage = {
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cost: 0,
        }
        let finishReason = ""

        try {
            while (true) {
                const readResult = await Promise.race([
                    reader.read(),
                    new Promise<never>((_, reject) =>
                        setTimeout(
                            () => reject(new Error("Stream stalled: no data received within timeout")),
                            this.streamStallTimeoutMs
                        )
                    ),
                ])
                const { done, value } = readResult
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() || ""

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (trimmed === "" || trimmed === "data: [DONE]") continue
                    if (!trimmed.startsWith("data: ")) continue

                    const jsonStr = trimmed.slice(6).trim()

                    let chunk: StreamChunk
                    try {
                        chunk = JSON.parse(jsonStr)
                    } catch {
                        logger?.warn("Failed to parse SSE chunk", { raw: jsonStr })
                        continue
                    }

                    if (chunk.usage) {
                        this.extractUsage(chunk.usage, usage)
                    }

                    const choice = chunk.choices?.[0]
                    if (!choice?.delta) continue

                    if (choice.delta.content) {
                        content += choice.delta.content
                    }

                    if (choice.delta.tool_calls) {
                        for (const tc of choice.delta.tool_calls) {
                            if (tc.id) {
                                if (!toolCallBuffer[tc.id]) {
                                    toolCallBuffer[tc.id] = { id: tc.id, name: "", arguments: "" }
                                }
                                const entry = toolCallBuffer[tc.id]
                                if (entry && tc.function?.name) {
                                    entry.name += tc.function.name
                                }
                                if (entry && tc.function?.arguments) {
                                    entry.arguments += tc.function.arguments
                                }
                            } else {
                                const ids = Object.keys(toolCallBuffer)
                                const lastId = ids[ids.length - 1]
                                const lastEntry = lastId ? toolCallBuffer[lastId] : undefined
                                if (lastEntry) {
                                    if (tc.function?.name) {
                                        lastEntry.name += tc.function.name
                                    }
                                    if (tc.function?.arguments) {
                                        lastEntry.arguments += tc.function.arguments
                                    }
                                }
                            }
                        }
                    }

                    if (choice.finish_reason) {
                        finishReason = choice.finish_reason
                    }
                }
            }
        } finally {
            reader.releaseLock()
        }

        const toolCalls: ToolCall[] = Object.values(toolCallBuffer).map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
                name: tc.name,
                arguments: tc.arguments,
            },
        }))

        return {
            content: content || null,
            toolCalls,
            usage,
            finishReason,
        }
    }

    private extractUsage(raw: Record<string, unknown>, target: LLMUsage): void {
        const promptTokens = (raw.prompt_tokens ?? raw.promptTokens ?? 0) as number
        const completionTokens = (raw.completion_tokens ?? raw.completionTokens ?? 0) as number
        const reasoningTokens = (raw.reasoning_tokens ?? raw.reasoningTokens ?? 0) as number
        const cost = (raw.cost ?? raw.total_cost ?? 0) as number

        if (promptTokens > target.promptTokens) target.promptTokens = promptTokens
        if (completionTokens > target.completionTokens) target.completionTokens = completionTokens
        if (reasoningTokens > target.reasoningTokens) target.reasoningTokens = reasoningTokens
        if (cost > target.cost) target.cost = cost
    }
}
