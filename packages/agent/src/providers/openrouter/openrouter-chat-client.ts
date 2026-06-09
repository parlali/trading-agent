import { readFiniteNumber, retryWithBackoff } from "@valiq-trading/core"
import type { Logger } from "@valiq-trading/core"
import { createEmptyUsage, type LLMUsage } from "../../llm-usage"

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
                index?: number
                id?: string
                type?: string
                function?: { name?: string; arguments?: string }
            }>
        }
        finish_reason?: string | null
    }>
    usage?: Record<string, unknown>
}

type StreamedToolCallBuffer = {
    index: number
    id: string
    name: string
    arguments: string
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
                shouldRetry: (error) => !isAbortError(error) && !isStreamProtocolError(error),
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

            return await this.processStream(response, logger, signal)
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
        const toolCallBuffer = new Map<number, StreamedToolCallBuffer>()
        const usage = createEmptyUsage()
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
                    const index = tc.index
                    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
                        throw createStreamProtocolError("OpenRouter stream tool call is missing a valid index")
                    }

                    let entry = toolCallBuffer.get(index)
                    if (!entry) {
                        entry = {
                            index,
                            id: "",
                            name: "",
                            arguments: "",
                        }
                        toolCallBuffer.set(index, entry)
                    }

                    if (tc.id) {
                        if (entry.id && entry.id !== tc.id) {
                            throw createStreamProtocolError(`OpenRouter stream changed tool call id for index ${index}`)
                        }
                        entry.id = tc.id
                    }
                    if (tc.function?.name) {
                        entry.name += tc.function.name
                    }
                    if (tc.function?.arguments) {
                        entry.arguments += tc.function.arguments
                    }
                }
            }
        }

        try {
            while (true) {
                throwIfSignalAborted(signal)
                const readResult = await readStreamChunkWithTimeout(reader, this.streamStallTimeoutMs, signal)
                const { done, value } = readResult
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() || ""

                for (const line of lines) {
                    handleLine(line)
                }
            }
            buffer += decoder.decode()
            if (buffer.trim().length > 0) {
                handleLine(buffer)
            }
        } finally {
            reader.releaseLock()
        }

        const toolCalls: ToolCall[] = Array.from(toolCallBuffer.values())
            .sort((left, right) => left.index - right.index)
            .map((tc) => {
                if (!tc.id || !tc.name) {
                    throw createStreamProtocolError(`OpenRouter stream produced incomplete tool call at index ${tc.index}`)
                }

                return {
                    id: tc.id,
                    type: "function" as const,
                    function: {
                        name: tc.name,
                        arguments: tc.arguments,
                    },
                }
            })

        return {
            content: content || null,
            toolCalls,
            usage,
            finishReason,
        }
    }

    private extractUsage(raw: Record<string, unknown>, target: LLMUsage): void {
        const promptTokens = readFiniteNumber(raw.prompt_tokens) ?? readFiniteNumber(raw.promptTokens) ?? 0
        const completionTokens = readFiniteNumber(raw.completion_tokens) ?? readFiniteNumber(raw.completionTokens) ?? 0
        const reasoningTokens = readFiniteNumber(raw.reasoning_tokens) ?? readFiniteNumber(raw.reasoningTokens) ?? 0
        const cost = readFiniteNumber(raw.cost) ?? readFiniteNumber(raw.total_cost) ?? 0

        if (promptTokens > target.promptTokens) target.promptTokens = promptTokens
        if (completionTokens > target.completionTokens) target.completionTokens = completionTokens
        if (reasoningTokens > target.reasoningTokens) target.reasoningTokens = reasoningTokens
        if (cost > target.cost) target.cost = cost
    }
}

function readStreamChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
    throwIfSignalAborted(signal)

    return new Promise((resolve, reject) => {
        let settled = false
        const settle = (callback: () => void) => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timeoutId)
            signal?.removeEventListener("abort", onAbort)
            callback()
        }

        const cancelReader = () => {
            void reader.cancel().catch(() => undefined)
        }
        const onAbort = () => {
            cancelReader()
            settle(() => reject(createOpenRouterAbortError()))
        }
        const timeoutId = setTimeout(() => {
            cancelReader()
            settle(() => reject(new Error("Stream stalled: no data received within timeout")))
        }, timeoutMs)

        signal?.addEventListener("abort", onAbort, { once: true })
        void reader.read().then(
            (result) => settle(() => resolve(result)),
            (error) => settle(() => reject(error))
        )
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

function isStreamProtocolError(error: unknown): boolean {
    return error instanceof Error && error.name === "OpenRouterStreamProtocolError"
}

function createOpenRouterAbortError(): Error {
    const error = new Error("LLM request timed out or was cancelled")
    error.name = "AbortError"
    return error
}

function createStreamProtocolError(message: string): Error {
    const error = new Error(message)
    error.name = "OpenRouterStreamProtocolError"
    return error
}

export type LLMClientConfig = OpenRouterChatClientConfig
export type LLMResponse = OpenRouterChatResponse
export const LLMClient = OpenRouterChatClient
