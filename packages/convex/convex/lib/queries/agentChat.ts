import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUserOrServiceToken } from "../authGuards"

const MAX_AGENT_CHAT_TRANSCRIPT_MESSAGES = 40
const MAX_AGENT_CHAT_TOOL_EVENTS = 200

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
        const rows = await ctx.db
            .query("agent_chat_messages")
            .withIndex("by_session_created_at", (q) => q.eq("sessionId", args.sessionId))
            .order("desc")
            .take(limit)
        const messageIds = new Set(rows.map((row) => row.messageId))
        const toolRows = await ctx.db
            .query("agent_chat_tool_events")
            .withIndex("by_session_created_at", (q) => q.eq("sessionId", args.sessionId))
            .order("desc")
            .take(MAX_AGENT_CHAT_TOOL_EVENTS)
        const toolEventsByMessageId = new Map<string, Array<{
            toolCallId: string
            toolName: string
            state: "input" | "result" | "error"
            input?: unknown
            output?: unknown
            error?: string
            durationMs?: number
            createdAt: number
        }>>()

        for (const row of toolRows.reverse()) {
            if (!messageIds.has(row.messageId)) {
                continue
            }

            const events = toolEventsByMessageId.get(row.messageId) ?? []
            events.push({
                toolCallId: row.toolCallId,
                toolName: row.toolName,
                state: row.state,
                input: row.input,
                output: row.output,
                error: row.error,
                durationMs: row.durationMs,
                createdAt: row.createdAt,
            })
            toolEventsByMessageId.set(row.messageId, events)
        }

        return rows
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
    },
})
