import type { ChatMessage, ToolCall } from "./llm-client";
export declare class ConversationManager {
    private messages;
    private sequence;
    addSystemMessage(content: string): void;
    addUserMessage(content: string): void;
    addAssistantMessage(content: string | null, toolCalls?: ToolCall[]): void;
    addToolResult(toolCallId: string, name: string, content: string): void;
    getMessages(): ChatMessage[];
    getSequence(): number;
    getLastAssistantContent(): string | null;
    getMessageCount(): number;
}
//# sourceMappingURL=conversation.d.ts.map