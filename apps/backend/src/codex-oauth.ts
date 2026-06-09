import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
    inspectCodexChatGptAuthStatusSync,
    resolveCodexChatGptAccountId,
    writeCodexChatGptAuthFileSync,
    type CodexChatGptAuthStatus,
} from "./codex-auth"

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
const DEFAULT_CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback"
const CODEX_OAUTH_SCOPE = "openid profile email offline_access"
const CODEX_OAUTH_SESSION_TTL_MS = 15 * 60 * 1000

type CodexOAuthFlowStatus =
    | "idle"
    | "awaiting_redirect"
    | "submitting"
    | "complete"
    | "failed"
    | "cancelled"
    | "expired"

interface CodexOAuthSession {
    status: Extract<CodexOAuthFlowStatus, "awaiting_redirect" | "submitting">
    state: string
    codeVerifier: string
    redirectUri: string
    authUrl: string
    startedAt: number
    updatedAt: number
}

export interface CodexOAuthSnapshot {
    status: CodexOAuthFlowStatus
    ready: boolean
    authUrl: string | null
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    startedAt: string | null
    updatedAt: string | null
    completedAt: string | null
    message: string
}

interface CodexOAuthTerminalState {
    status: Exclude<CodexOAuthFlowStatus, "idle" | "awaiting_redirect" | "submitting">
    message: string
    completedAt: number
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
        logger: config.logger,
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
                const payload = await readJsonRecord(request)
                return json(controller.start({
                    redirectUri: readString(payload.redirectUri),
                }), 200)
            }

            if (request.method === "POST" && pathname === "/codex/oauth/cancel") {
                return json(controller.cancel(), 200)
            }

            if (request.method === "POST" && pathname === "/codex/oauth/submit") {
                const payload = await readJsonRecord(request)
                const redirectUrl = typeof payload.redirectUrl === "string" ? payload.redirectUrl : ""
                return json(await controller.submit(redirectUrl), 200)
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
    private activeSession: CodexOAuthSession | null = null
    private terminalState: CodexOAuthTerminalState | null = null

    constructor(private readonly config: {
        env: Record<string, string | undefined>
        logger?: {
            info(message: string, metadata?: Record<string, unknown>): void
            warn(message: string, metadata?: Record<string, unknown>): void
            error(message: string, metadata?: Record<string, unknown>): void
        }
    }) {}

    getSnapshot(): CodexOAuthSnapshot {
        this.expireSessionIfNeeded()
        const authStatus = inspectCodexChatGptAuthStatusSync(this.config.env)

        if (this.activeSession) {
            return buildSnapshot({
                flowStatus: this.activeSession.status,
                authStatus,
                authUrl: this.activeSession.authUrl,
                startedAt: this.activeSession.startedAt,
                updatedAt: this.activeSession.updatedAt,
                completedAt: null,
                message: this.activeSession.status === "submitting"
                    ? "Completing Codex ChatGPT login"
                    : "Waiting for ChatGPT callback or pasted redirect URL",
            })
        }

        if (authStatus.ready) {
            return buildSnapshot({
                flowStatus: "complete",
                authStatus,
                authUrl: null,
                startedAt: null,
                updatedAt: null,
                completedAt: this.terminalState?.status === "complete" ? this.terminalState.completedAt : null,
                message: authStatus.message,
            })
        }

        if (this.terminalState) {
            return buildSnapshot({
                flowStatus: this.terminalState.status,
                authStatus,
                authUrl: null,
                startedAt: null,
                updatedAt: null,
                completedAt: this.terminalState.completedAt,
                message: this.terminalState.message,
            })
        }

        return buildSnapshot({
            flowStatus: "idle",
            authStatus,
            authUrl: null,
            startedAt: null,
            updatedAt: null,
            completedAt: null,
            message: authStatus.message,
        })
    }

    start(args: { redirectUri?: string | null } = {}): CodexOAuthSnapshot {
        const now = Date.now()
        const codeVerifier = base64Url(randomBytes(32))
        const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest())
        const state = base64Url(randomBytes(24))
        const redirectUri = resolveOAuthRedirectUri(args.redirectUri)
        const authUrl = buildAuthorizationUrl({
            state,
            codeChallenge,
            redirectUri,
        })

        this.activeSession = {
            status: "awaiting_redirect",
            state,
            codeVerifier,
            redirectUri,
            authUrl,
            startedAt: now,
            updatedAt: now,
        }
        this.terminalState = null

        this.config.logger?.info("Codex OAuth flow started", {
            codexHome: inspectCodexChatGptAuthStatusSync(this.config.env).codexHome,
        })

        return this.getSnapshot()
    }

    cancel(): CodexOAuthSnapshot {
        if (this.activeSession) {
            this.activeSession = null
            this.terminalState = {
                status: "cancelled",
                message: "Codex ChatGPT login was cancelled",
                completedAt: Date.now(),
            }
        }

        return this.getSnapshot()
    }

    async submit(redirectUrl: string): Promise<CodexOAuthSnapshot> {
        this.expireSessionIfNeeded()

        if (!this.activeSession) {
            throw new Error("No Codex ChatGPT login is waiting for a redirect URL")
        }

        const session = {
            ...this.activeSession,
            status: "submitting" as const,
            updatedAt: Date.now(),
        }
        this.activeSession = session

        try {
            const code = extractAuthorizationCode(redirectUrl, session.state)
            const tokenResponse = await exchangeAuthorizationCode({
                code,
                codeVerifier: session.codeVerifier,
                redirectUri: session.redirectUri,
            })
            const accessToken = readRequiredString(tokenResponse.access_token, "access_token")
            const refreshToken = readRequiredString(tokenResponse.refresh_token, "refresh_token")
            const idToken = readRequiredString(tokenResponse.id_token, "id_token")
            const accountId = resolveCodexChatGptAccountId(tokenResponse, accessToken, idToken)

            if (!accountId) {
                throw new Error("OpenAI OAuth token did not include a ChatGPT account id")
            }

            writeCodexChatGptAuthFileSync({
                env: this.config.env,
                tokens: {
                    idToken,
                    accessToken,
                    refreshToken,
                    accountId,
                },
            })

            this.activeSession = null
            this.terminalState = {
                status: "complete",
                message: "Codex ChatGPT login is active",
                completedAt: Date.now(),
            }

            this.config.logger?.info("Codex OAuth flow completed", {
                accountId,
            })

            return this.getSnapshot()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.activeSession = null
            this.terminalState = {
                status: "failed",
                message,
                completedAt: Date.now(),
            }
            throw error
        }
    }

    private expireSessionIfNeeded(): void {
        if (!this.activeSession) {
            return
        }

        if (Date.now() - this.activeSession.startedAt <= CODEX_OAUTH_SESSION_TTL_MS) {
            return
        }

        this.activeSession = null
        this.terminalState = {
            status: "expired",
            message: "Codex ChatGPT login timed out before the redirect URL was submitted",
            completedAt: Date.now(),
        }
    }
}

export function buildAuthorizationUrl(args: {
    state: string
    codeChallenge: string
    redirectUri?: string
}): string {
    const params = new URLSearchParams({
        response_type: "code",
        client_id: CODEX_OAUTH_CLIENT_ID,
        redirect_uri: resolveOAuthRedirectUri(args.redirectUri),
        scope: CODEX_OAUTH_SCOPE,
        state: args.state,
        code_challenge: args.codeChallenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli",
    })

    return `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

export function extractAuthorizationCode(redirectUrl: string, expectedState: string): string {
    const value = redirectUrl.trim()
    if (!value) {
        throw new Error("Paste the full ChatGPT redirect URL")
    }

    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new Error("Paste the full ChatGPT redirect URL, not only the authorization code")
    }

    const error = parsed.searchParams.get("error")
    if (error) {
        throw new Error(`OpenAI OAuth returned an error: ${error}`)
    }

    const state = parsed.searchParams.get("state")
    if (state !== expectedState) {
        throw new Error("ChatGPT redirect state did not match the active Codex login")
    }

    const code = parsed.searchParams.get("code")
    if (!code) {
        throw new Error("ChatGPT redirect URL did not include an authorization code")
    }

    return code
}

async function exchangeAuthorizationCode(args: {
    code: string
    codeVerifier: string
    redirectUri: string
}): Promise<Record<string, unknown>> {
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
            "accept": "application/json",
            "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CODEX_OAUTH_CLIENT_ID,
            redirect_uri: resolveOAuthRedirectUri(args.redirectUri),
            code: args.code,
            code_verifier: args.codeVerifier,
        }),
    })

    if (!response.ok) {
        throw new Error(`OpenAI OAuth token exchange failed with status ${response.status}`)
    }

    return readRecord(await response.json() as unknown)
}

function buildSnapshot(args: {
    flowStatus: CodexOAuthFlowStatus
    authStatus: CodexChatGptAuthStatus
    authUrl: string | null
    startedAt: number | null
    updatedAt: number | null
    completedAt: number | null
    message: string
}): CodexOAuthSnapshot {
    return {
        status: args.flowStatus,
        ready: args.authStatus.ready,
        authUrl: args.authUrl,
        codexHome: args.authStatus.codexHome,
        authFilePath: args.authStatus.authFilePath,
        accountId: args.authStatus.accountId,
        lastRefresh: args.authStatus.lastRefresh,
        startedAt: formatDate(args.startedAt),
        updatedAt: formatDate(args.updatedAt),
        completedAt: formatDate(args.completedAt),
        message: args.message,
    }
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
    try {
        return readRecord(await request.json() as unknown)
    } catch {
        return {}
    }
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function readRequiredString(value: unknown, name: string): string {
    if (typeof value === "string" && value.trim()) {
        return value
    }

    throw new Error(`OpenAI OAuth token response did not include ${name}`)
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}

export function resolveOAuthRedirectUri(value?: string | null): string {
    const redirectUri = value?.trim() || DEFAULT_CODEX_OAUTH_REDIRECT_URI

    let parsed: URL
    try {
        parsed = new URL(redirectUri)
    } catch {
        throw new Error("Codex OAuth redirect URI is invalid")
    }

    if (parsed.protocol === "https:") {
        return parsed.toString()
    }

    const isLocalhost = parsed.protocol === "http:"
        && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")

    if (isLocalhost) {
        return parsed.toString()
    }

    throw new Error("Codex OAuth redirect URI must use https, except localhost")
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

function base64Url(bytes: Buffer): string {
    return bytes.toString("base64url")
}

function formatDate(value: number | null): string | null {
    return value ? new Date(value).toISOString() : null
}
