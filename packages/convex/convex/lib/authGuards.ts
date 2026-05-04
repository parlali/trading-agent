const BACKEND_SERVICE_TOKEN_ENV_VAR = "BACKEND_SERVICE_TOKEN"

export function readConvexEnv(): Record<string, string | undefined> {
    return (
        globalThis as {
            process?: {
                env?: Record<string, string | undefined>
            }
        }
    ).process?.env ?? {}
}

function readBackendServiceToken(): string {
    const env = readConvexEnv()[BACKEND_SERVICE_TOKEN_ENV_VAR]?.trim()

    if (!env) {
        throw new Error(
            `${BACKEND_SERVICE_TOKEN_ENV_VAR} is not configured in Convex environment variables`
        )
    }

    return env
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

export function requireServiceToken(serviceToken: string): void {
    if (!serviceToken.trim()) {
        throw new Error("Machine-only action requires a backend service token")
    }

    const expectedToken = readBackendServiceToken()

    if (!timingSafeEqual(serviceToken, expectedToken)) {
        throw new Error("Invalid backend service token")
    }
}

export async function requireUserOrServiceToken(
    ctx: { auth: { getUserIdentity: () => Promise<unknown> } },
    serviceToken?: string
): Promise<void> {
    if (serviceToken) {
        requireServiceToken(serviceToken)
        return
    }

    await requireUser(ctx)
}
