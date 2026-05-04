import { action } from "./_generated/server"
import { v } from "convex/values"
import { readConvexEnv, requireServiceToken } from "./lib/authGuards"

export const resolveSecrets = action({
    args: {
        keys: v.array(v.string()),
        serviceToken: v.string(),
    },
    handler: async (_ctx, args) => {
        requireServiceToken(args.serviceToken)

        const resolved: Record<string, string | null> = {}
        const env = readConvexEnv()

        for (const key of args.keys) {
            resolved[key] = env[key] ?? null
        }

        return resolved
    },
})
