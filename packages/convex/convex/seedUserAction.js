"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Scrypt } from "lucia";
export const seedUser = internalAction({
    args: {
        email: v.string(),
        password: v.string(),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.runQuery(internal.seedUserHelpers.findUserByEmail, { email: args.email });
        if (existing) {
            return { status: "already_exists", email: args.email };
        }
        const scrypt = new Scrypt();
        const secret = await scrypt.hash(args.password);
        const userId = await ctx.runMutation(internal.seedUserHelpers.insertUser, { email: args.email });
        await ctx.runMutation(internal.seedUserHelpers.insertAuthAccount, { userId, email: args.email, secret });
        return { status: "created", email: args.email, userId };
    },
});
