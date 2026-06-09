import { timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync } from "node:fs"
import {
    inspectCodexChatGptAuthStatusSync,
    resolveCodexHome,
    type CodexChatGptAuthStatus,
} from "./codex-auth"

const CODEX_DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000
const CODEX_DEVICE_LOGIN_START_WAIT_MS = 5 * 1000
const MAX_CAPTURED_OUTPUT_LENGTH = 16_384
const CODEX_DEVICE_LOGIN_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device\b/u
const CODEX_DEVICE_LOGIN_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/u
const CODEX_LOCALHOST_CALLBACK_PATTERN = /\b(?:localhost|127\.0\.0\.1):1455\b|\/auth\/callback/u

type CodexOAuthFlowStatus = "idle" | "starting" | "awaiting_device" | "complete" | "failed" | "expired"
type ActiveCodexOAuthFlowStatus = Extract<CodexOAuthFlowStatus, "starting" | "awaiting_device">
type TerminalCodexOAuthFlowStatus = Extract<CodexOAuthFlowStatus, "failed" | "expired">

export interface CodexOAuthSnapshot {
    status: CodexOAuthFlowStatus
    ready: boolean
    deviceVerificationUrl: string | null
    userCode: string | null
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    startedAt: string | null
    updatedAt: string | null
    expiresAt: string | null
    message: string
}

interface CodexDeviceLoginProcess {
    pid?: number
    stdout: CodexDeviceLoginStream
    stderr: CodexDeviceLoginStream
    kill(signal?: NodeJS.Signals): boolean
    once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
    once(event: "error", listener: (error: Error) => void): unknown
}

interface CodexDeviceLoginStream {
    on(event: "data", listener: (chunk: unknown) => void): unknown
}

interface CodexDeviceLoginSession {
    status: ActiveCodexOAuthFlowStatus
    process: CodexDeviceLoginProcess
    stdout: string
    stderr: string
    deviceVerificationUrl: string | null
    userCode: string | null
    startedAt: number
    updatedAt: number
    expiresAt: number
    fallbackDetected: boolean
    waiters: Set<() => void>
}

interface CodexOAuthTerminalState {
    status: TerminalCodexOAuthFlowStatus
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
    spawnDeviceLogin?: (args: {
        codexBin: string
        codexHome: string
        env: Record<string, string | undefined>
    }) => CodexDeviceLoginProcess
}): (request: Request) => Promise<Response | undefined> {
    const controller = new CodexOAuthController({
        env: config.env ?? process.env,
        logger: config.logger,
        spawnDeviceLogin: config.spawnDeviceLogin,
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
                return json(await controller.start(), 200)
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
    private activeSession: CodexDeviceLoginSession | null = null
    private terminalState: CodexOAuthTerminalState | null = null

    constructor(private readonly config: {
        env: Record<string, string | undefined>
        logger?: {
            info(message: string, metadata?: Record<string, unknown>): void
            warn(message: string, metadata?: Record<string, unknown>): void
            error(message: string, metadata?: Record<string, unknown>): void
        }
        spawnDeviceLogin?: (args: {
            codexBin: string
            codexHome: string
            env: Record<string, string | undefined>
        }) => CodexDeviceLoginProcess
    }) {}

    async start(): Promise<CodexOAuthSnapshot> {
        const authStatus = inspectCodexChatGptAuthStatusSync(this.config.env)
        if (authStatus.ready) {
            return this.getSnapshot()
        }

        this.expireActiveSessionIfNeeded()
        if (this.activeSession) {
            return await this.waitForDeviceChallenge(this.activeSession)
        }

        this.terminalState = null

        try {
            const session = this.startDeviceLoginSession()
            return await this.waitForDeviceChallenge(session)
        } catch (error) {
            this.terminalState = {
                status: "failed",
                message: `Codex device-code login failed to start: ${error instanceof Error ? error.message : String(error)}`,
                completedAt: Date.now(),
            }
            return this.getSnapshot()
        }
    }

    getSnapshot(): CodexOAuthSnapshot {
        this.expireActiveSessionIfNeeded()
        const authStatus = inspectCodexChatGptAuthStatusSync(this.config.env)

        if (authStatus.ready) {
            this.clearActiveSession()
            this.terminalState = null
            return buildSnapshot({
                flowStatus: "complete",
                authStatus,
                message: authStatus.message,
            })
        }

        if (this.activeSession) {
            return buildSnapshot({
                flowStatus: this.activeSession.status,
                authStatus,
                deviceVerificationUrl: this.activeSession.deviceVerificationUrl,
                userCode: this.activeSession.userCode,
                startedAt: this.activeSession.startedAt,
                updatedAt: this.activeSession.updatedAt,
                expiresAt: this.activeSession.expiresAt,
                message: this.activeSession.status === "awaiting_device"
                    ? "Open the Codex device login link and enter the one-time code"
                    : "Starting Codex device-code login",
            })
        }

        if (this.terminalState) {
            return buildSnapshot({
                flowStatus: this.terminalState.status,
                authStatus,
                updatedAt: this.terminalState.completedAt,
                message: this.terminalState.message,
            })
        }

        return buildSnapshot({
            flowStatus: "idle",
            authStatus,
            message: authStatus.message,
        })
    }

    private startDeviceLoginSession(): CodexDeviceLoginSession {
        const codexHome = resolveCodexHome(this.config.env)
        mkdirSync(codexHome, {
            recursive: true,
            mode: 0o700,
        })
        chmodSync(codexHome, 0o700)

        const codexBin = this.config.env.CODEX_BIN?.trim() || "codex"
        const child = (this.config.spawnDeviceLogin ?? spawnCodexDeviceLogin)({
            codexBin,
            codexHome,
            env: this.config.env,
        })
        const now = Date.now()
        const session: CodexDeviceLoginSession = {
            status: "starting",
            process: child,
            stdout: "",
            stderr: "",
            deviceVerificationUrl: null,
            userCode: null,
            startedAt: now,
            updatedAt: now,
            expiresAt: now + CODEX_DEVICE_LOGIN_TTL_MS,
            fallbackDetected: false,
            waiters: new Set(),
        }

        this.activeSession = session
        child.stdout.on("data", (chunk) => this.handleDeviceLoginOutput(session, "stdout", chunk))
        child.stderr.on("data", (chunk) => this.handleDeviceLoginOutput(session, "stderr", chunk))
        child.once("error", (error) => {
            this.failSession(session, "failed", `Codex device-code login failed to start: ${error.message}`)
        })
        child.once("close", (code, signal) => {
            this.handleDeviceLoginClose(session, code, signal)
        })

        this.config.logger?.info("Codex device-code login started", {
            codexHome,
        })

        return session
    }

    private handleDeviceLoginOutput(
        session: CodexDeviceLoginSession,
        stream: "stdout" | "stderr",
        chunk: unknown
    ): void {
        if (this.activeSession !== session) {
            return
        }

        const text = stripAnsi(String(chunk))
        session[stream] = appendBoundedOutput(session[stream], text)
        session.updatedAt = Date.now()

        const captured = `${session.stdout}\n${session.stderr}`
        if (CODEX_LOCALHOST_CALLBACK_PATTERN.test(captured)) {
            session.fallbackDetected = true
            this.failSession(
                session,
                "failed",
                "Codex device-code login is unavailable; browser/localhost callback login is disabled",
                true
            )
            return
        }

        const deviceUrl = CODEX_DEVICE_LOGIN_URL_PATTERN.exec(captured)?.[0]
        const userCode = CODEX_DEVICE_LOGIN_CODE_PATTERN.exec(captured)?.[0]

        if (deviceUrl) {
            session.deviceVerificationUrl = deviceUrl
        }

        if (userCode) {
            session.userCode = userCode
        }

        if (session.deviceVerificationUrl && session.userCode) {
            session.status = "awaiting_device"
        }

        this.notifyWaiters(session)
    }

    private handleDeviceLoginClose(
        session: CodexDeviceLoginSession,
        code: number | null,
        signal: NodeJS.Signals | null
    ): void {
        if (this.activeSession !== session) {
            return
        }

        const authStatus = inspectCodexChatGptAuthStatusSync(this.config.env)
        if (authStatus.ready) {
            this.activeSession = null
            this.terminalState = null
            this.notifyWaiters(session)
            return
        }

        const reason = signal
            ? `signal ${signal}`
            : `exit code ${code ?? "unknown"}`
        this.failSession(
            session,
            "failed",
            `Codex device-code login ended before ChatGPT authorized the backend (${reason})`
        )
    }

    private async waitForDeviceChallenge(session: CodexDeviceLoginSession): Promise<CodexOAuthSnapshot> {
        if (session.status !== "starting") {
            return this.getSnapshot()
        }

        let waiter: (() => void) | null = null
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, CODEX_DEVICE_LOGIN_START_WAIT_MS)
            waiter = () => {
                clearTimeout(timeout)
                resolve()
            }
            session.waiters.add(waiter)
        }).finally(() => {
            if (waiter) {
                session.waiters.delete(waiter)
            }
        })

        return this.getSnapshot()
    }

    private failSession(
        session: CodexDeviceLoginSession,
        status: TerminalCodexOAuthFlowStatus,
        message: string,
        terminate = false
    ): void {
        if (this.activeSession !== session) {
            return
        }

        this.activeSession = null
        this.terminalState = {
            status,
            message,
            completedAt: Date.now(),
        }

        if (terminate) {
            session.process.kill("SIGTERM")
        }

        this.notifyWaiters(session)
    }

    private expireActiveSessionIfNeeded(): void {
        if (!this.activeSession || Date.now() <= this.activeSession.expiresAt) {
            return
        }

        this.failSession(
            this.activeSession,
            "expired",
            "Codex device code expired before ChatGPT authorized the backend",
            true
        )
    }

    private clearActiveSession(): void {
        const session = this.activeSession
        if (!session) {
            return
        }

        this.activeSession = null
        session.process.kill("SIGTERM")
        this.notifyWaiters(session)
    }

    private notifyWaiters(session: CodexDeviceLoginSession): void {
        for (const waiter of session.waiters) {
            waiter()
        }
    }
}

function buildSnapshot(args: {
    flowStatus: CodexOAuthFlowStatus
    authStatus: CodexChatGptAuthStatus
    deviceVerificationUrl?: string | null
    userCode?: string | null
    startedAt?: number | null
    updatedAt?: number | null
    expiresAt?: number | null
    message: string
}): CodexOAuthSnapshot {
    return {
        status: args.flowStatus,
        ready: args.authStatus.ready,
        deviceVerificationUrl: args.deviceVerificationUrl ?? null,
        userCode: args.userCode ?? null,
        codexHome: args.authStatus.codexHome,
        authFilePath: args.authStatus.authFilePath,
        accountId: args.authStatus.accountId,
        lastRefresh: args.authStatus.lastRefresh,
        startedAt: formatDate(args.startedAt ?? null),
        updatedAt: formatDate(args.updatedAt ?? null),
        expiresAt: formatDate(args.expiresAt ?? null),
        message: args.message,
    }
}

function spawnCodexDeviceLogin(args: {
    codexBin: string
    codexHome: string
    env: Record<string, string | undefined>
}): CodexDeviceLoginProcess {
    return spawn(args.codexBin, [
        "login",
        "--device-auth",
        "-c",
        "cli_auth_credentials_store=\"file\"",
    ], {
        env: {
            ...process.env,
            ...args.env,
            CODEX_HOME: args.codexHome,
            NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
    })
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

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/gu, "")
}

function appendBoundedOutput(current: string, next: string): string {
    const value = `${current}${next}`
    return value.length > MAX_CAPTURED_OUTPUT_LENGTH
        ? value.slice(value.length - MAX_CAPTURED_OUTPUT_LENGTH)
        : value
}

function formatDate(value: number | null): string | null {
    return value ? new Date(value).toISOString() : null
}
