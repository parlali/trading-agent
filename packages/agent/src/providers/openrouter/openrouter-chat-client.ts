import { retryWithBackoff } from "@valiq-trading/core"
import type { Logger } from "@valiq-trading/core"

export interface OpenRouterChatClientConfig {
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
    responseIds: string[]
}

export interface OpenRouterChatResponse {
    content: string | null
    toolCalls: ToolCall[]
    usage: LLMUsage
    finishReason: string
}

interface StreamChunk {
    id?: string
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

export class OpenRouterChatClient {
    private apiKey: string
    private model: string
    private reasoning?: OpenRouterReasoningConfig
    private baseUrl: string
    private controller: AbortController | null = null
    private requestTimeoutMs: number
    private streamStallTimeoutMs: number

    constructor(config: OpenRouterChatClientConfig) {
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
        maxRetries = 3,
        signal?: AbortSignal
    ): Promise<OpenRouterChatResponse> {
        return retryWithBackoff(
            () => this.doChat(messages, tools, logger, signal),
            maxRetries,
            2000,
            {
                signal,
                shouldRetry: (error) => !isAbortError(error),
            }
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
        logger?: Logger,
        externalSignal?: AbortSignal
    ): Promise<OpenRouterChatResponse> {
        throwIfSignalAborted(externalSignal)
        this.controller = new AbortController()
        const signal = this.controller.signal
        const abortFromExternal = () => {
            this.controller?.abort()
        }
        externalSignal?.addEventListener("abort", abortFromExternal, { once: true })

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

            return await this.processStream(response, logger, externalSignal)
        } catch (error) {
            if (isAbortError(error) || externalSignal?.aborted) {
                throw createOpenRouterAbortError()
            }
            throw error
        } finally {
            clearTimeout(requestTimer)
            externalSignal?.removeEventListener("abort", abortFromExternal)
            this.controller = null
        }
    }

    private async processStream(
        response: Response,
        logger?: Logger,
        signal?: AbortSignal
    ): Promise<OpenRouterChatResponse> {
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
            responseIds: [],
        }
        let finishReason = ""

        const handleLine = (line: string): void => {
            const trimmed = line.trim()
            if (trimmed === "" || trimmed === "data: [DONE]") return
            if (!trimmed.startsWith("data: ")) return

            const jsonStr = trimmed.slice(6).trim()

            let chunk: StreamChunk
            try {
                chunk = JSON.parse(jsonStr)
            } catch {
                logger?.warn("Failed to parse SSE chunk", { raw: jsonStr })
                return
            }

            if (chunk.usage) {
                this.extractUsage(chunk.usage, usage)
            }

            if (typeof chunk.id === "string" && chunk.id.length > 0 && !usage.responseIds.includes(chunk.id)) {
                usage.responseIds.push(chunk.id)
            }

            const choice = chunk.choices?.[0]
            if (choice?.finish_reason) {
                finishReason = choice.finish_reason
            }
            if (!choice?.delta) return

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
        }

        try {
            while (true) {
                throwIfSignalAborted(signal)
                const readResult = await readStreamChunkWithTimeout(reader, this.streamStallTimeoutMs)
                const { done, value } = readResult
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() || ""

                for (const line of lines) {
                    handleLine(line)
                }
            }
            if (buffer.trim().length > 0) {
                handleLine(buffer)
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

function readStreamChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    return Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error("Stream stalled: no data received within timeout")),
                timeoutMs
            )
        }),
    ]).finally(() => {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
    })
}

function throwIfSignalAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createOpenRouterAbortError()
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError"
}

function createOpenRouterAbortError(): Error {
    const error = new Error("LLM request timed out or was cancelled")
    error.name = "AbortError"
    return error
}

export type LLMClientConfig = OpenRouterChatClientConfig
export type LLMResponse = OpenRouterChatResponse
export const LLMClient = OpenRouterChatClient
