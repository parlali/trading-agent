import { internalMutation, internalQuery } from "./_generated/server"
import { v } from "convex/values"

export const findUserByEmail = internalQuery({
    args: { email: v.string() },
    handler: async (ctx, args) => {
        const accounts = await ctx.db.query("authAccounts").collect()
        return accounts.find(
            (account) =>
                account.provider === "password" &&
                account.providerAccountId === args.email
        ) ?? null
    },
})

export const insertUser = internalMutation({
    args: { email: v.string() },
    handler: async (ctx, args) => {
        return await ctx.db.insert("users", {
            email: args.email,
            emailVerificationTime: Date.now(),
        })
    },
})

export const insertAuthAccount = internalMutation({
    args: {
        userId: v.id("users"),
        email: v.string(),
        secret: v.string(),
    },
    handler: async (ctx, args) => {
        return await ctx.db.insert("authAccounts", {
            userId: args.userId,
            provider: "password",
            providerAccountId: args.email,
            secret: args.secret,
        })
    },
})
