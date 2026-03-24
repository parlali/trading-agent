import type { ChatMessage, ToolCall } from "./llm-client"

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
        this.messages.push({
            role: "tool",
            content,
            tool_call_id: toolCallId,
            name,
        })
        this.sequence++
    }

    getMessages(): ChatMessage[] {
        return [...this.messages]
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
