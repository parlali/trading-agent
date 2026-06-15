import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUserOrServiceToken } from "../authGuards"
import { decodeAgentChatToolPayload, type AgentChatToolPayload } from "../agentChatToolPayload"

const MAX_AGENT_CHAT_TRANSCRIPT_MESSAGES = 40

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
            toolEventsByMessageId.set(result.messageId, result.rows.map((row) => ({
                toolCallId: row.toolCallId,
                toolName: row.toolName,
                state: row.state,
                input: decodeAgentChatToolPayload(row.input as AgentChatToolPayload | undefined),
                output: decodeAgentChatToolPayload(row.output as AgentChatToolPayload | undefined),
                error: row.error,
                durationMs: row.durationMs,
                createdAt: row.createdAt,
            })))
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
