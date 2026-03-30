import type { ActionCtx } from "./_generated/server"
import { action } from "./_generated/server"
import { v } from "convex/values"

const BACKEND_SERVICE_TOKEN_ENV_VAR = "BACKEND_SERVICE_TOKEN"

function readEnv(): Record<string, string | undefined> {
    return (
        globalThis as {
            process?: {
                env?: Record<string, string | undefined>
            }
        }
    ).process?.env ?? {}
}

function readBackendServiceToken(): string {
    const env = readEnv()[BACKEND_SERVICE_TOKEN_ENV_VAR]?.trim()

    if (!env) {
        throw new Error(
            `${BACKEND_SERVICE_TOKEN_ENV_VAR} is not configured in Convex environment variables`
        )
    }

    return env
}

async function requireBackendServiceAuth(ctx: ActionCtx, serviceToken: string): Promise<void> {
    const identity = await ctx.auth.getUserIdentity()

    if (identity) {
        throw new Error("Machine-only action cannot be called with a user-authenticated identity")
    }

    if (!serviceToken.trim()) {
        throw new Error("Machine-only action requires a backend service token")
    }

    const expectedToken = readBackendServiceToken()
    if (serviceToken !== expectedToken) {
        throw new Error("Invalid backend service token")
    }
}

export const resolveSecrets = action({
    args: {
        keys: v.array(v.string()),
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        await requireBackendServiceAuth(ctx, args.serviceToken)

        const resolved: Record<string, string | null> = {}
        const env = readEnv()

        for (const key of args.keys) {
            resolved[key] = env[key] ?? null
        }

        return resolved
    },
})
