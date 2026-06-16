import { mutation } from "../../_generated/server"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"
import { agentChatToolPayloadV } from "../validators"

const DEFAULT_STALE_AGENT_CHAT_TIMEOUT_MS = 180_000

const chatModeV = v.union(
    v.literal("general"),
    v.literal("portfolio"),
    v.literal("operations"),
    v.literal("mcp")
)

export const recordAgentChatUserMessage = mutation({
    args: {
        serviceToken: v.string(),
        sessionId: v.string(),
        messageId: v.string(),
        content: v.string(),
        mode: v.optional(chatModeV),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const existing = await ctx.db
            .query("agent_chat_messages")
            .withIndex("by_session_message", (q) => q.eq("sessionId", args.sessionId).eq("messageId", args.messageId))
            .unique()

        if (existing) {
            assertSameAgentChatMessage(existing, {
                role: "user",
                content: args.content,
                mode: args.mode,
                status: "received",
            })
            return
        }

        await ctx.db.insert("agent_chat_messages", {
            sessionId: args.sessionId,
            messageId: args.messageId,
            role: "user",
            content: args.content,
            mode: args.mode,
            status: "received",
            createdAt: now,
            updatedAt: now,
        })
    },
})

export const recordAgentChatAssistantMessage = mutation({
    args: {
        serviceToken: v.string(),
        sessionId: v.string(),
        messageId: v.string(),
        content: v.string(),
        status: v.union(
            v.literal("running"),
            v.literal("completed"),
            v.literal("cancelled"),
            v.literal("failed")
        ),
        modelProvider: v.string(),
        modelId: v.string(),
        finishReason: v.optional(v.string()),
        reasoning: v.optional(v.string()),
        error: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const existing = await ctx.db
            .query("agent_chat_messages")
            .withIndex("by_session_message", (q) => q.eq("sessionId", args.sessionId).eq("messageId", args.messageId))
            .unique()

        const patch = {
            role: "assistant" as const,
            content: args.content,
            status: args.status,
            modelProvider: args.modelProvider,
            modelId: args.modelId,
            finishReason: args.finishReason,
            reasoning: args.reasoning,
            error: args.error,
        }

        if (existing) {
            if (existing.status === "running" && args.status !== "running") {
                await ctx.db.patch(existing._id, {
                    ...patch,
                    updatedAt: now,
                })
                return
            }

            assertSameAgentChatMessage(existing, patch)
            return
        }

        await ctx.db.insert("agent_chat_messages", {
            sessionId: args.sessionId,
            messageId: args.messageId,
            ...patch,
            createdAt: now,
            updatedAt: now,
        })
    },
})

export const recordAgentChatToolEvent = mutation({
    args: {
        serviceToken: v.string(),
        sessionId: v.string(),
        messageId: v.string(),
        toolCallId: v.string(),
        toolName: v.string(),
        state: v.union(
            v.literal("input"),
            v.literal("result"),
            v.literal("error")
        ),
        input: v.optional(agentChatToolPayloadV),
        output: v.optional(agentChatToolPayloadV),
        error: v.optional(v.string()),
        durationMs: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("agent_chat_tool_events", {
            sessionId: args.sessionId,
            messageId: args.messageId,
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            state: args.state,
            input: args.input,
            output: args.output,
            error: args.error,
            durationMs: args.durationMs,
            createdAt: Date.now(),
        })
    },
})

export const recoverStaleAgentChatMessages = mutation({
    args: {
        serviceToken: v.string(),
        olderThanMs: v.optional(v.number()),
        maxBatch: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const olderThanMs = args.olderThanMs ?? DEFAULT_STALE_AGENT_CHAT_TIMEOUT_MS
        const recoveredAt = Date.now()
        const staleBefore = recoveredAt - olderThanMs
        const maxBatch = Math.max(1, Math.min(args.maxBatch ?? 500, 5_000))
        const runningMessages = await ctx.db
            .query("agent_chat_messages")
            .withIndex("by_status_updated_at", (q) => q.eq("status", "running"))
            .order("asc")
            .take(maxBatch)
        let recovered = 0

        for (const message of runningMessages) {
            if (message.role !== "assistant" || message.updatedAt >= staleBefore) {
                continue
            }

            await ctx.db.patch(message._id, {
                status: "failed",
                finishReason: "stale-running-recovered",
                error: "Recovered stale agent chat turn after backend interruption or timeout",
                updatedAt: recoveredAt,
            })
            recovered++
        }

        return { recovered }
    },
})

function assertSameAgentChatMessage(
    existing: Record<string, unknown>,
    expected: Record<string, unknown>
): void {
    const conflicts = Object.entries(expected)
        .filter(([field, value]) => (existing[field] ?? undefined) !== (value ?? undefined))
        .map(([field]) => field)

    if (conflicts.length > 0) {
        throw new Error(`Agent chat message id conflict for immutable audit record: ${conflicts.join(", ")}`)
    }
}
