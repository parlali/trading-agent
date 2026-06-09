import { mutation } from "../../_generated/server"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"

export const storeCodexChatGptAuth = mutation({
    args: {
        serviceToken: v.string(),
        authJson: v.string(),
        accountId: v.string(),
        lastRefresh: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const existing = await ctx.db
            .query("codex_chatgpt_auth")
            .withIndex("by_key", (q) => q.eq("key", "chatgpt"))
            .first()

        if (existing) {
            await ctx.db.patch(existing._id, {
                authJson: args.authJson,
                accountId: args.accountId,
                lastRefresh: args.lastRefresh,
                updatedAt: now,
            })
            return existing._id
        }

        return await ctx.db.insert("codex_chatgpt_auth", {
            key: "chatgpt",
            authJson: args.authJson,
            accountId: args.accountId,
            lastRefresh: args.lastRefresh,
            createdAt: now,
            updatedAt: now,
        })
    },
})
