const MAX_TOOL_RESULT_LENGTH = 8000;
export class ConversationManager {
    messages = [];
    sequence = 0;
    addSystemMessage(content) {
        this.messages.push({ role: "system", content });
        this.sequence++;
    }
    addUserMessage(content) {
        this.messages.push({ role: "user", content });
        this.sequence++;
    }
    addAssistantMessage(content, toolCalls) {
        const message = { role: "assistant", content };
        if (toolCalls && toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }
        this.messages.push(message);
        this.sequence++;
    }
    addToolResult(toolCallId, name, content) {
        const truncated = content.length > MAX_TOOL_RESULT_LENGTH
            ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n...[truncated from ${content.length} chars]`
            : content;
        this.messages.push({
            role: "tool",
            content: truncated,
            tool_call_id: toolCallId,
            name,
        });
        this.sequence++;
    }
    getMessages() {
        return [...this.messages];
    }
    getSequence() {
        return this.sequence;
    }
    getLastAssistantContent() {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const msg = this.messages[i];
            if (msg?.role === "assistant" && msg.content) {
                return msg.content;
            }
        }
        return null;
    }
    getMessageCount() {
        return this.messages.length;
    }
}
