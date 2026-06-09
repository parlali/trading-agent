import { timingSafeEqual } from "node:crypto"
import {
    inspectCodexChatGptAuthStatusSync,
    type CodexChatGptAuthStatus,
} from "./codex-auth"

const CODEX_OAUTH_START_UNSUPPORTED_MESSAGE = [
    "Codex ChatGPT dashboard login cannot start",
    "OpenAI rejected hosted callback URLs for the Codex OAuth client",
    "Refusing to start a non-completable login flow",
].join(": ")

type CodexOAuthFlowStatus = "idle" | "complete"

export interface CodexOAuthSnapshot {
    status: CodexOAuthFlowStatus
    ready: boolean
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    message: string
}

export function createCodexOAuthControlHandler(config: {
    serviceToken: string
    env?: Record<string, string | undefined>
    logger?: {
        info(message: string, metadata?: Record<string, unknown>): void
        warn(message: string, metadata?: Record<string, unknown>): void
        error(message: string, metadata?: Record<string, unknown>): void
    }
}): (request: Request) => Promise<Response | undefined> {
    const controller = new CodexOAuthController({
        env: config.env ?? process.env,
    })

    return async (request: Request): Promise<Response | undefined> => {
        const { pathname } = new URL(request.url)
        if (!pathname.startsWith("/codex/oauth")) {
            return undefined
        }

        if (!hasServiceToken(request, config.serviceToken)) {
            return json({ error: "Unauthorized" }, 401)
        }

        try {
            if (request.method === "GET" && pathname === "/codex/oauth/status") {
                return json(controller.getSnapshot(), 200)
            }

            if (request.method === "POST" && pathname === "/codex/oauth/start") {
                throw new Error(CODEX_OAUTH_START_UNSUPPORTED_MESSAGE)
            }

            return json({ error: "Not Found" }, 404)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            config.logger?.warn("Codex OAuth control request failed", {
                path: pathname,
                error: message,
            })
            return json({ error: message }, 400)
        }
    }
}

export class CodexOAuthController {
    constructor(private readonly config: {
        env: Record<string, string | undefined>
    }) {}

    getSnapshot(): CodexOAuthSnapshot {
        const authStatus = inspectCodexChatGptAuthStatusSync(this.config.env)

        return buildSnapshot({
            flowStatus: authStatus.ready ? "complete" : "idle",
            authStatus,
            message: authStatus.message,
        })
    }
}

function buildSnapshot(args: {
    flowStatus: CodexOAuthFlowStatus
    authStatus: CodexChatGptAuthStatus
    message: string
}): CodexOAuthSnapshot {
    return {
        status: args.flowStatus,
        ready: args.authStatus.ready,
        codexHome: args.authStatus.codexHome,
        authFilePath: args.authStatus.authFilePath,
        accountId: args.authStatus.accountId,
        lastRefresh: args.authStatus.lastRefresh,
        message: args.message,
    }
}

function json(payload: unknown, status: number): Response {
    return Response.json(payload, {
        status,
        headers: {
            "cache-control": "no-store",
        },
    })
}

function hasServiceToken(request: Request, expectedToken: string): boolean {
    const provided = readBearerToken(request.headers.get("authorization"))
    if (!provided || !expectedToken.trim()) {
        return false
    }

    const providedBytes = Buffer.from(provided)
    const expectedBytes = Buffer.from(expectedToken)
    return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
}

function readBearerToken(header: string | null): string | null {
    const prefix = "Bearer "
    if (!header?.startsWith(prefix)) {
        return null
    }

    const token = header.slice(prefix.length).trim()
    return token || null
}
