import { action } from "./_generated/server"
import { v } from "convex/values"

// Resolve secrets from Convex environment variables.
// All broker credentials, API keys, and tokens are stored as Convex env vars
// and accessed at runtime. The only local env var apps need is CONVEX_URL.
export const resolveSecrets = action({
    args: {
        keys: v.array(v.string()),
    },
    handler: async (_ctx, args) => {
        const resolved: Record<string, string | null> = {}
        // Convex actions run in Node.js and have access to environment variables
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {}

        for (const key of args.keys) {
            resolved[key] = env[key] ?? null
        }

        return resolved
    },
})
