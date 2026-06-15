import { describe, expect, it } from "vitest"
import {
    recordAgentChatAssistantMessage,
    recordAgentChatUserMessage,
} from "../../convex/lib/mutations/agentChat"
import { getAgentChatMessages } from "../../convex/lib/queries/agentChat"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("agent chat audit mutations", () => {
    it("keeps repeated identical user messages idempotent", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_messages: [],
        })
        const args = {
            serviceToken: "test-token",
            sessionId: "session-1",
            messageId: "message-1",
            content: "hello",
            mode: "general",
        }

        await callRegistered(recordAgentChatUserMessage, { db } as never, args)
        await callRegistered(recordAgentChatUserMessage, { db } as never, args)

        expect(db.rows.agent_chat_messages).toHaveLength(1)
        expect(db.rows.agent_chat_messages?.[0]).toMatchObject({
            role: "user",
            content: "hello",
        })
    })

    it("rejects conflicting reuse of a user message id", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_messages: [],
        })

        await callRegistered(recordAgentChatUserMessage, { db } as never, {
            serviceToken: "test-token",
            sessionId: "session-1",
            messageId: "message-1",
            content: "hello",
        })

        await expect(callRegistered(recordAgentChatUserMessage, { db } as never, {
            serviceToken: "test-token",
            sessionId: "session-1",
            messageId: "message-1",
            content: "changed",
        })).rejects.toThrow("Agent chat message id conflict")
    })

    it("stores assistant reasoning and errors separately from content", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_messages: [],
        })

        await callRegistered(recordAgentChatAssistantMessage, { db } as never, {
            serviceToken: "test-token",
            sessionId: "session-1",
            messageId: "message-1:assistant",
            content: "visible answer",
            status: "failed",
            modelProvider: "ai-gateway",
            modelId: "openai/gpt-5",
            finishReason: "error",
            reasoning: "provider summary",
            error: "provider failed",
        })

        expect(db.rows.agent_chat_messages?.[0]).toMatchObject({
            content: "visible answer",
            reasoning: "provider summary",
            error: "provider failed",
        })
    })

    it("returns tool events with transcript messages for dashboard reload", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_messages: [{
                _id: "assistant-row",
                sessionId: "session-1",
                messageId: "message-1:assistant",
                role: "assistant",
                content: "done",
                status: "completed",
                createdAt: 1,
                updatedAt: 1,
            }],
            agent_chat_tool_events: [
                {
                    _id: "tool-input",
                    sessionId: "session-1",
                    messageId: "message-1:assistant",
                    toolCallId: "call-1",
                    toolName: "list_accounts",
                    state: "input",
                    input: {},
                    createdAt: 2,
                },
                {
                    _id: "tool-result",
                    sessionId: "session-1",
                    messageId: "message-1:assistant",
                    toolCallId: "call-1",
                    toolName: "list_accounts",
                    state: "result",
                    input: {},
                    output: { accounts: [] },
                    createdAt: 3,
                },
            ],
        })

        const messages = await callRegistered(getAgentChatMessages, { db } as never, {
            serviceToken: "test-token",
            sessionId: "session-1",
        }) as Array<{
            toolEvents: Array<{ state: string; toolName: string; output?: unknown }>
        }>

        expect(messages[0]?.toolEvents).toEqual([
            expect.objectContaining({
                state: "input",
                toolName: "list_accounts",
            }),
            expect.objectContaining({
                state: "result",
                toolName: "list_accounts",
                output: { accounts: [] },
            }),
        ])
    })
})
