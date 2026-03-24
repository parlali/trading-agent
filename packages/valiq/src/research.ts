import type { Logger } from "@valiq-trading/core"
import type { ValiqClient } from "./client"
import type {
    ChatResponse,
    SSEEvent,
    FinalResponseData,
    CompletionData,
    ErrorData,
} from "./types"

export interface ResearchResult {
    content: string
    completionData?: CompletionData
}

export class ValiqResearchAdapter {
    private currentChatId: string | null = null
    private logger?: Logger

    constructor(
        private client: ValiqClient,
        logger?: Logger
    ) {
        this.logger = logger
    }

    async createChat(): Promise<string> {
        const result = await this.client.request<ChatResponse>("/chats", {
            method: "POST",
            body: JSON.stringify({}),
        })
        this.currentChatId = result.id
        this.logger?.info("ValiqResearch chat created", { chatId: result.id })
        return result.id
    }

    async sendQuestion(chatId: string, question: string): Promise<ResearchResult> {
        this.logger?.info("ValiqResearch sending question", {
            chatId,
            questionLength: question.length,
        })

        const stream = await this.client.requestSSE(
            `/chats/${chatId}/messages`,
            { content: question },
            { timeout: 120_000 }
        )

        return this.consumeSSEStream(stream)
    }

    async clearChat(chatId: string): Promise<void> {
        await this.client.request(`/chats/${chatId}`, {
            method: "DELETE",
        })
        if (this.currentChatId === chatId) {
            this.currentChatId = null
        }
        this.logger?.info("ValiqResearch chat cleared", { chatId })
    }

    getChatId(): string | null {
        return this.currentChatId
    }

    async clearCurrentChat(): Promise<void> {
        if (!this.currentChatId) {
            return
        }

        await this.clearChat(this.currentChatId)
    }

    private async consumeSSEStream(stream: ReadableStream<Uint8Array>): Promise<ResearchResult> {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let finalContent = ""
        let completionData: CompletionData | undefined

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })

                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (trimmed === "" || trimmed.startsWith(":")) continue

                    if (trimmed === "data: [DONE]") {
                        this.logger?.debug("ValiqResearch SSE stream done")
                        continue
                    }

                    if (!trimmed.startsWith("data: ")) continue

                    const json = trimmed.slice(6)
                    let event: SSEEvent
                    try {
                        event = JSON.parse(json) as SSEEvent
                    } catch {
                        this.logger?.warn("ValiqResearch failed to parse SSE event", {
                            raw: json.slice(0, 200),
                        })
                        continue
                    }

                    if (event.type === "final_response") {
                        const data = event.data as unknown as FinalResponseData
                        finalContent += data.content
                    } else if (event.type === "completion") {
                        completionData = event.data as unknown as CompletionData
                        if (completionData.finalContent) {
                            finalContent = completionData.finalContent
                        }
                    } else if (event.type === "error") {
                        const data = event.data as unknown as ErrorData
                        this.logger?.error("ValiqResearch SSE error event", {
                            message: data.message,
                            code: data.code,
                        })
                        throw new Error(`Val-iQ research error: ${data.message}`)
                    }
                }
            }
        } finally {
            reader.releaseLock()
        }

        if (!finalContent && completionData?.finalContent) {
            finalContent = completionData.finalContent
        }

        this.logger?.info("ValiqResearch response received", {
            contentLength: finalContent.length,
        })

        return { content: finalContent, completionData }
    }
}
