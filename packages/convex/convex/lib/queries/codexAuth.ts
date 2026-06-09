import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"

export const getCodexChatGptAuth = query({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const row = await ctx.db
            .query("codex_chatgpt_auth")
            .withIndex("by_key", (q) => q.eq("key", "chatgpt"))
            .first()

        if (!row) {
            return null
        }

        return {
            authJson: row.authJson,
            accountId: row.accountId,
            lastRefresh: row.lastRefresh,
            updatedAt: row.updatedAt,
        }
    },
})
