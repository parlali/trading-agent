import { describe, expect, it } from "vitest"
import {
    recordAgentChatAssistantMessage,
    recordAgentChatToolEvent,
    recordAgentChatUserMessage,
    recoverStaleAgentChatMessages,
} from "../../convex/lib/mutations/agentChat"
import { getAgentChatMessages } from "../../convex/lib/queries/agentChat"
import { encodeAgentChatToolPayload } from "../../convex/lib/agentChatToolPayload"
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
            modelProvider: "openrouter",
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

    it("updates a running assistant placeholder into one terminal audit row", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_messages: [],
        })
        const running = {
            serviceToken: "test-token",
            sessionId: "session-1",
            messageId: "message-1:assistant",
            content: "",
            status: "running",
            modelProvider: "codex",
            modelId: "gpt-5.5",
        }
        const completed = {
            ...running,
            content: "done",
            status: "completed",
            finishReason: "stop",
        }

        await callRegistered(recordAgentChatAssistantMessage, { db } as never, running)
        await callRegistered(recordAgentChatAssistantMessage, { db } as never, completed)
        await callRegistered(recordAgentChatAssistantMessage, { db } as never, completed)

        expect(db.rows.agent_chat_messages).toHaveLength(1)
        expect(db.rows.agent_chat_messages?.[0]).toMatchObject({
            content: "done",
            status: "completed",
            finishReason: "stop",
        })
        await expect(callRegistered(recordAgentChatAssistantMessage, { db } as never, {
            ...completed,
            status: "failed",
            error: "changed",
        })).rejects.toThrow("Agent chat message id conflict")
    })

    it("stores tool input and output as versioned payload envelopes", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_tool_events: [],
        })

        await callRegistered(recordAgentChatToolEvent, { db } as never, {
            serviceToken: "test-token",
            sessionId: "session-1",
            messageId: "message-1:assistant",
            toolCallId: "call-1",
            toolName: "list_accounts",
            state: "result",
            input: encodeAgentChatToolPayload({ accountId: "acct-1" }),
            output: encodeAgentChatToolPayload({ accounts: ["acct-1"] }),
        })

        expect(db.rows.agent_chat_tool_events?.[0]).toMatchObject({
            input: {
                schemaVersion: 1,
                encoding: "json",
                json: "{\"accountId\":\"acct-1\"}",
            },
            output: {
                schemaVersion: 1,
                encoding: "json",
                json: "{\"accounts\":[\"acct-1\"]}",
            },
        })
    })

    it("returns tool events with transcript messages when newer session events exceed the old global cap", async () => {
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
                    input: encodeAgentChatToolPayload({}),
                    createdAt: 2,
                },
                {
                    _id: "tool-result",
                    sessionId: "session-1",
                    messageId: "message-1:assistant",
                    toolCallId: "call-1",
                    toolName: "list_accounts",
                    state: "result",
                    input: encodeAgentChatToolPayload({}),
                    output: encodeAgentChatToolPayload({ accounts: [] }),
                    createdAt: 3,
                },
                ...Array.from({ length: 201 }, (_, index) => ({
                    _id: `noise-${index}`,
                    sessionId: "session-1",
                    messageId: `noise-${index}:assistant`,
                    toolCallId: `noise-call-${index}`,
                    toolName: "mcp_noise",
                    state: "input",
                    input: encodeAgentChatToolPayload({ index }),
                    createdAt: 4 + index,
                })),
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

    it("surfaces orphaned tool events as a failed assistant transcript turn", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            agent_chat_messages: [{
                _id: "user-row",
                sessionId: "session-1",
                messageId: "message-2",
                role: "user",
                content: "test tools",
                status: "received",
                createdAt: 1,
                updatedAt: 1,
            }],
            agent_chat_tool_events: [
                {
                    _id: "orphan-tool-input",
                    sessionId: "session-1",
                    messageId: "message-2:assistant",
                    toolCallId: "call-1",
                    toolName: "list_accounts",
                    state: "input",
                    input: encodeAgentChatToolPayload({}),
                    createdAt: 2,
                },
                {
                    _id: "orphan-tool-result",
                    sessionId: "session-1",
                    messageId: "message-2:assistant",
                    toolCallId: "call-1",
                    toolName: "list_accounts",
                    state: "result",
                    input: encodeAgentChatToolPayload({}),
                    output: encodeAgentChatToolPayload({ accounts: ["acct-1"] }),
                    createdAt: 3,
                },
            ],
        })

        const messages = await callRegistered(getAgentChatMessages, { db } as never, {
            serviceToken: "test-token",
            sessionId: "session-1",
        }) as Array<{
            messageId: string
            role: string
            status: string
            error?: string
            toolEvents: Array<{ state: string; toolName: string; output?: unknown }>
        }>

        expect(messages).toHaveLength(2)
        expect(messages[1]).toMatchObject({
            messageId: "message-2:assistant",
            role: "assistant",
            status: "failed",
            error: "Agent chat tool execution was recorded but no terminal assistant response was saved.",
            toolEvents: [
                expect.objectContaining({
                    state: "input",
                    toolName: "list_accounts",
                }),
                expect.objectContaining({
                    state: "result",
                    toolName: "list_accounts",
                    output: { accounts: ["acct-1"] },
                }),
            ],
        })
    })

    it("recovers stale running assistant turns without touching fresh or user rows", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const now = Date.now()
        const db = new FakeDb({
            agent_chat_messages: [
                {
                    _id: "stale-assistant",
                    sessionId: "session-1",
                    messageId: "message-1:assistant",
                    role: "assistant",
                    content: "",
                    status: "running",
                    modelProvider: "codex",
                    modelId: "gpt-5.5",
                    createdAt: now - 300_000,
                    updatedAt: now - 300_000,
                },
                {
                    _id: "fresh-assistant",
                    sessionId: "session-1",
                    messageId: "message-2:assistant",
                    role: "assistant",
                    content: "",
                    status: "running",
                    modelProvider: "codex",
                    modelId: "gpt-5.5",
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    _id: "user-row",
                    sessionId: "session-1",
                    messageId: "message-3",
                    role: "user",
                    content: "hello",
                    status: "running",
                    createdAt: now - 300_000,
                    updatedAt: now - 300_000,
                },
            ],
        })

        const result = await callRegistered(recoverStaleAgentChatMessages, { db } as never, {
            serviceToken: "test-token",
            olderThanMs: 120_000,
        }) as { recovered: number }

        expect(result).toEqual({ recovered: 1 })
        expect(db.rows.agent_chat_messages?.find((row) => row._id === "stale-assistant")).toMatchObject({
            status: "failed",
            finishReason: "stale-running-recovered",
            error: "Recovered stale agent chat turn after backend interruption or timeout",
        })
        expect(db.rows.agent_chat_messages?.find((row) => row._id === "fresh-assistant")).toMatchObject({
            status: "running",
        })
        expect(db.rows.agent_chat_messages?.find((row) => row._id === "user-row")).toMatchObject({
            status: "running",
        })
    })
})
