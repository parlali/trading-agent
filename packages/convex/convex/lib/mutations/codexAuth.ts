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
            if (existing.accountId !== args.accountId) {
                throw new Error("Codex ChatGPT auth account mismatch")
            }

            if (isOlderRefresh(args.lastRefresh, existing.lastRefresh)) {
                return existing._id
            }

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

function isOlderRefresh(incoming: string | undefined, existing: string | undefined): boolean {
    const existingTime = parseRefreshTime(existing)
    if (existingTime === null) {
        return false
    }

    const incomingTime = parseRefreshTime(incoming)
    if (incomingTime === null) {
        return true
    }

    return incomingTime < existingTime
}

function parseRefreshTime(value: string | undefined): number | null {
    if (!value) {
        return null
    }

    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
}
