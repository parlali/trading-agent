import type { Logger } from "@valiq-trading/core";
import type { ValiqClient } from "./client";
import type { CompletionData } from "./types";
export interface ResearchResult {
    content: string;
    completionData?: CompletionData;
}
export declare class ValiqResearchAdapter {
    private client;
    private currentChatId;
    private logger?;
    constructor(client: ValiqClient, logger?: Logger);
    createChat(): Promise<string>;
    sendQuestion(chatId: string, question: string): Promise<ResearchResult>;
    clearChat(chatId: string): Promise<void>;
    getChatId(): string | null;
    clearCurrentChat(): Promise<void>;
    private consumeSSEStream;
}
//# sourceMappingURL=research.d.ts.map