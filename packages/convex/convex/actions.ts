import { action } from "./_generated/server"
import { v } from "convex/values"
import { requireServiceToken } from "./lib/authGuards"

function readEnv(): Record<string, string | undefined> {
    return (
        globalThis as {
            process?: {
                env?: Record<string, string | undefined>
            }
        }
    ).process?.env ?? {}
}

export const resolveSecrets = action({
    args: {
        keys: v.array(v.string()),
        serviceToken: v.string(),
    },
    handler: async (_ctx, args) => {
        requireServiceToken(args.serviceToken)

        const resolved: Record<string, string | null> = {}
        const env = readEnv()

        for (const key of args.keys) {
            resolved[key] = env[key] ?? null
        }

        return resolved
    },
})
