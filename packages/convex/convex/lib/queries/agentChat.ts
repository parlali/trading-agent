import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUserOrServiceToken } from "../authGuards"

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
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            }))
    },
})
