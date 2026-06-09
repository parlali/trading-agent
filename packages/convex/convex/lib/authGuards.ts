const BACKEND_SERVICE_TOKEN_ENV_VAR = "BACKEND_SERVICE_TOKEN"

type ServiceTokenAuthContext = {
    backendServiceToken?: string
}

export function readConvexEnv(): Record<string, string | undefined> {
    return (
        globalThis as {
            process?: {
                env?: Record<string, string | undefined>
            }
        }
    ).process?.env ?? {}
}

function readBackendServiceToken(ctx?: ServiceTokenAuthContext): string {
    const env = ctx?.backendServiceToken?.trim() ?? readConvexEnv()[BACKEND_SERVICE_TOKEN_ENV_VAR]?.trim()

    if (!env) {
        throw new Error(
            `${BACKEND_SERVICE_TOKEN_ENV_VAR} is not configured in Convex environment variables`
        )
    }

    return env
}

function readServiceTokenAuthContext(ctx: unknown): ServiceTokenAuthContext | undefined {
    if (!ctx || typeof ctx !== "object") {
        return undefined
    }

    const backendServiceToken = (ctx as { backendServiceToken?: unknown }).backendServiceToken

    return typeof backendServiceToken === "string" ? { backendServiceToken } : undefined
}

export async function requireUser(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }): Promise<void> {
    const identity = await ctx.auth.getUserIdentity()

    if (!identity) {
        throw new Error("Authentication required")
    }
}

function timingSafeEqual(a: string, b: string): boolean {
    const maxLen = Math.max(a.length, b.length)
    let mismatch = a.length ^ b.length

    for (let i = 0; i < maxLen; i++) {
        mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
    }

    return mismatch === 0
}

export function requireServiceToken(serviceToken: string, ctx?: ServiceTokenAuthContext): void {
    if (!serviceToken.trim()) {
        throw new Error("Machine-only action requires a backend service token")
    }

    const expectedToken = readBackendServiceToken(ctx)

    if (!timingSafeEqual(serviceToken, expectedToken)) {
        throw new Error("Invalid backend service token")
    }
}

export function requireServiceTokenForContext(serviceToken: string, ctx: unknown): void {
    const authContext = readServiceTokenAuthContext(ctx)
    if (!authContext?.backendServiceToken?.trim()) {
        throw new Error("Machine-only action requires backend service token context")
    }

    requireServiceToken(serviceToken, authContext)
}

export function requireServiceTokenFromEnv(serviceToken: string): void {
    requireServiceTokenForContext(serviceToken, {
        backendServiceToken: readBackendServiceToken(),
    })
}

export function requireServiceTokenForQueryContext(serviceToken: string, ctx: unknown): void {
    const authContext = readServiceTokenAuthContext(ctx)
    if (authContext?.backendServiceToken?.trim()) {
        requireServiceTokenForContext(serviceToken, authContext)
        return
    }

    requireServiceTokenFromEnv(serviceToken)
}

export async function requireUserOrServiceToken(
    ctx: { auth: { getUserIdentity: () => Promise<unknown> } },
    serviceToken?: string
): Promise<void> {
    if (serviceToken) {
        requireServiceTokenForQueryContext(serviceToken, ctx)
        return
    }

    await requireUser(ctx)
}
