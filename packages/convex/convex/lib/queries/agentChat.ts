import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUserOrServiceToken } from "../authGuards"
import { decodeAgentChatToolPayload, type AgentChatToolPayload } from "../agentChatToolPayload"

const MAX_AGENT_CHAT_TRANSCRIPT_MESSAGES = 40
const MAX_AGENT_CHAT_ORPHAN_TOOL_EVENTS = 200
const ORPHAN_TOOL_TURN_ERROR = "Agent chat tool execution was recorded but no terminal assistant response was saved."

type AgentChatToolEventView = {
    toolCallId: string
    toolName: string
    state: "input" | "result" | "error"
    input?: unknown
    output?: unknown
    error?: string
    durationMs?: number
    createdAt: number
}

export const getAgentChatMessages = query({
    args: {
        serviceToken: v.optional(v.string()),
        sessionId: v.string(),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const limit = Math.min(
            MAX_AGENT_CHAT_TRANSCRIPT_MESSAGES,
            Math.max(1, Math.floor(args.limit ?? MAX_AGENT_CHAT_TRANSCRIPT_MESSAGES))
        )
        const [rows, recentToolEvents] = await Promise.all([
            ctx.db
                .query("agent_chat_messages")
                .withIndex("by_session_created_at", (q) => q.eq("sessionId", args.sessionId))
                .order("desc")
                .take(limit),
            ctx.db
                .query("agent_chat_tool_events")
                .withIndex("by_session_created_at", (q) => q.eq("sessionId", args.sessionId))
                .order("desc")
                .take(MAX_AGENT_CHAT_ORPHAN_TOOL_EVENTS),
        ])
        const toolEventsByMessageId = new Map<string, AgentChatToolEventView[]>()
        const messageIds = new Set(rows.map((row) => row.messageId))

        const toolEventResults = await Promise.all(
            rows.map(async (message) => ({
                messageId: message.messageId,
                rows: await ctx.db
                    .query("agent_chat_tool_events")
                    .withIndex("by_session_message_created_at", (q) =>
                        q.eq("sessionId", message.sessionId).eq("messageId", message.messageId)
                    )
                    .order("asc")
                    .collect(),
            }))
        )

        for (const result of toolEventResults) {
            toolEventsByMessageId.set(result.messageId, result.rows.map(toAgentChatToolEventView))
        }

        const orphanToolEventsByMessageId = new Map<string, AgentChatToolEventView[]>()
        for (const event of recentToolEvents) {
            if (messageIds.has(event.messageId) || !event.messageId.endsWith(":assistant")) {
                continue
            }

            const grouped = orphanToolEventsByMessageId.get(event.messageId) ?? []
            grouped.push(toAgentChatToolEventView(event))
            orphanToolEventsByMessageId.set(event.messageId, grouped)
        }

        const persistedMessages = rows
            .reverse()
            .map((row) => ({
                id: String(row._id),
                sessionId: row.sessionId,
                messageId: row.messageId,
                role: row.role,
                content: row.content,
                mode: row.mode,
                status: row.status,
                modelProvider: row.modelProvider,
                modelId: row.modelId,
                finishReason: row.finishReason,
                reasoning: row.reasoning,
                error: row.error,
                toolEvents: toolEventsByMessageId.get(row.messageId) ?? [],
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            }))
        const orphanMessages = Array.from(orphanToolEventsByMessageId.entries())
            .map(([messageId, events]) => {
                const orderedEvents = events.sort((left, right) => left.createdAt - right.createdAt)
                const firstEvent = orderedEvents[0]
                const lastEvent = orderedEvents[orderedEvents.length - 1]
                if (!firstEvent || !lastEvent) {
                    return null
                }

                return {
                    id: `orphan:${messageId}`,
                    sessionId: args.sessionId,
                    messageId,
                    role: "assistant" as const,
                    content: "",
                    status: "failed" as const,
                    finishReason: "missing-terminal-assistant",
                    error: ORPHAN_TOOL_TURN_ERROR,
                    toolEvents: orderedEvents,
                    createdAt: firstEvent.createdAt,
                    updatedAt: lastEvent.createdAt,
                }
            })
            .filter(isNonNullable)

        return [...persistedMessages, ...orphanMessages]
            .sort((left, right) => left.createdAt - right.createdAt)
    },
})

function toAgentChatToolEventView(row: {
    toolCallId: string
    toolName: string
    state: "input" | "result" | "error"
    input?: AgentChatToolPayload
    output?: AgentChatToolPayload
    error?: string
    durationMs?: number
    createdAt: number
}): AgentChatToolEventView {
    return {
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        state: row.state,
        input: decodeAgentChatToolPayload(row.input),
        output: decodeAgentChatToolPayload(row.output),
        error: row.error,
        durationMs: row.durationMs,
        createdAt: row.createdAt,
    }
}

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}
