import type { Logger } from "@valiq-trading/core";
export interface LLMClientConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    requestTimeoutMs?: number;
    streamStallTimeoutMs?: number;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}
export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export interface OpenRouterTool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface LLMUsage {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cost: number;
}
export interface LLMResponse {
    content: string | null;
    toolCalls: ToolCall[];
    usage: LLMUsage;
    finishReason: string;
}
export declare class LLMClient {
    private apiKey;
    private model;
    private baseUrl;
    private controller;
    private requestTimeoutMs;
    private streamStallTimeoutMs;
    constructor(config: LLMClientConfig);
    chat(messages: ChatMessage[], tools?: OpenRouterTool[], logger?: Logger, maxRetries?: number): Promise<LLMResponse>;
    cancel(): void;
    private doChat;
    private processStream;
    private extractUsage;
}
//# sourceMappingURL=llm-client.d.ts.map