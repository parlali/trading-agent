import type { ChatMessage, ToolCall } from "./llm-client"

const MAX_TOOL_RESULT_LENGTH = 8000
const MAX_MESSAGES_BEFORE_TRIM = 40
const TRIM_KEEP_RECENT = 20

export class ConversationManager {
    private messages: ChatMessage[] = []
    private sequence = 0

    addSystemMessage(content: string): void {
        this.messages.push({ role: "system", content })
        this.sequence++
    }

    addUserMessage(content: string): void {
        this.messages.push({ role: "user", content })
        this.sequence++
    }

    addAssistantMessage(content: string | null, toolCalls?: ToolCall[]): void {
        const message: ChatMessage = { role: "assistant", content }
        if (toolCalls && toolCalls.length > 0) {
            message.tool_calls = toolCalls
        }
        this.messages.push(message)
        this.sequence++
    }

    addToolResult(toolCallId: string, name: string, content: string): void {
        const truncated = content.length > MAX_TOOL_RESULT_LENGTH
            ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n...[truncated from ${content.length} chars]`
            : content

        this.messages.push({
            role: "tool",
            content: truncated,
            tool_call_id: toolCallId,
            name,
        })
        this.sequence++
    }

    getMessages(): ChatMessage[] {
        if (this.messages.length <= MAX_MESSAGES_BEFORE_TRIM) {
            return [...this.messages]
        }

        const systemMessages = this.messages.filter((m) => m.role === "system")
        const nonSystem = this.messages.filter((m) => m.role !== "system")
        const recent = nonSystem.slice(-TRIM_KEEP_RECENT)

        return [...systemMessages, ...recent]
    }

    getSequence(): number {
        return this.sequence
    }

    getLastAssistantContent(): string | null {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const msg = this.messages[i]
            if (msg?.role === "assistant" && msg.content) {
                return msg.content
            }
        }
        return null
    }

    getMessageCount(): number {
        return this.messages.length
    }
}
