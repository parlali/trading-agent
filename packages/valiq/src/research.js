export class ValiqResearchAdapter {
    client;
    currentChatId = null;
    logger;
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
    }
    async createChat() {
        const result = await this.client.request("/chats", {
            method: "POST",
            body: JSON.stringify({ title: "Trading Agent Research" }),
        });
        this.currentChatId = result.id;
        this.logger?.info("ValiqResearch chat created", { chatId: result.id });
        return result.id;
    }
    async sendQuestion(chatId, question) {
        this.logger?.info("ValiqResearch sending question", {
            chatId,
            questionLength: question.length,
        });
        const stream = await this.client.requestSSE(`/chats/${chatId}/messages`, { content: question }, { timeout: 120_000 });
        return this.consumeSSEStream(stream);
    }
    async clearChat(chatId) {
        await this.client.request(`/chats/${chatId}`, {
            method: "DELETE",
        });
        if (this.currentChatId === chatId) {
            this.currentChatId = null;
        }
        this.logger?.info("ValiqResearch chat cleared", { chatId });
    }
    getChatId() {
        return this.currentChatId;
    }
    async clearCurrentChat() {
        if (!this.currentChatId) {
            return;
        }
        await this.clearChat(this.currentChatId);
    }
    async consumeSSEStream(stream) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalContent = "";
        let completionData;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === "" || trimmed.startsWith(":"))
                        continue;
                    if (trimmed === "data: [DONE]") {
                        this.logger?.debug("ValiqResearch SSE stream done");
                        continue;
                    }
                    if (!trimmed.startsWith("data: "))
                        continue;
                    const json = trimmed.slice(6);
                    let event;
                    try {
                        event = JSON.parse(json);
                    }
                    catch {
                        this.logger?.warn("ValiqResearch failed to parse SSE event", {
                            raw: json.slice(0, 200),
                        });
                        continue;
                    }
                    if (event.type === "final_response") {
                        const data = event.data;
                        finalContent += data.content;
                    }
                    else if (event.type === "completion") {
                        completionData = event.data;
                        if (completionData.finalContent) {
                            finalContent = completionData.finalContent;
                        }
                    }
                    else if (event.type === "error") {
                        const data = event.data;
                        this.logger?.error("ValiqResearch SSE error event", {
                            message: data.message,
                            code: data.code,
                        });
                        throw new Error(`Val-iQ research error: ${data.message}`);
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        if (!finalContent && completionData?.finalContent) {
            finalContent = completionData.finalContent;
        }
        this.logger?.info("ValiqResearch response received", {
            contentLength: finalContent.length,
        });
        return { content: finalContent, completionData };
    }
}
