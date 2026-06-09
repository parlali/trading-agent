import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import { writeCodexChatGptAuthFileSync, type CodexChatGptAuthFileSnapshot } from "./codex-auth"
import { createCodexOAuthControlHandler } from "./codex-oauth"

describe("Codex OAuth control handler", () => {
    it("reports missing ChatGPT login status", async () => {
        const codexHome = createTempCodexHome()

        try {
            const handler = createCodexOAuthControlHandler({
                serviceToken: "service-token",
                env: { CODEX_HOME: codexHome },
            })
            const response = await handler(new Request("http://backend/codex/oauth/status", {
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            const body = await response!.json() as Record<string, unknown>

            expect(response!.status).toBe(200)
            expect(body.status).toBe("idle")
            expect(body.ready).toBe(false)
            expect(body.deviceVerificationUrl).toBeNull()
            expect(body.userCode).toBeNull()
            expect(body.message).toBe("Codex ChatGPT login is missing")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("starts the Codex device-code login flow", async () => {
        const codexHome = createTempCodexHome()
        const deviceLogin = new FakeCodexDeviceLoginProcess()
        const logger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }
        const handler = createCodexOAuthControlHandler({
            serviceToken: "service-token",
            env: { CODEX_HOME: codexHome },
            logger,
            spawnDeviceLogin: vi.fn(() => deviceLogin),
        })

        try {
            const pendingResponse = handler(new Request("http://backend/codex/oauth/start", {
                method: "POST",
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            deviceLogin.writeStdout([
                "Follow these steps to sign in with ChatGPT using device code authorization:",
                "https://auth.openai.com/codex/device",
                "TEST-12345",
            ].join("\n"))
            const response = await pendingResponse
            const body = await response!.json() as Record<string, unknown>

            expect(response!.status).toBe(200)
            expect(body.status).toBe("awaiting_device")
            expect(body.ready).toBe(false)
            expect(body.deviceVerificationUrl).toBe("https://auth.openai.com/codex/device")
            expect(body.userCode).toBe("TEST-12345")
            expect(body.message).toBe("Open the Codex device login link and enter the one-time code")
            expect(logger.info).toHaveBeenCalledWith("Codex device-code login started", {
                codexHome,
            })
            expect(logger.warn).not.toHaveBeenCalled()
        } finally {
            deviceLogin.kill("SIGTERM")
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("reports ready after Codex writes ChatGPT auth.json", async () => {
        const codexHome = createTempCodexHome()
        const deviceLogin = new FakeCodexDeviceLoginProcess()
        const persistChatGptAuth = vi.fn(async (_auth: CodexChatGptAuthFileSnapshot) => {})
        const handler = createCodexOAuthControlHandler({
            serviceToken: "service-token",
            env: { CODEX_HOME: codexHome },
            spawnDeviceLogin: vi.fn(() => deviceLogin),
            persistChatGptAuth,
        })

        try {
            const pendingResponse = handler(new Request("http://backend/codex/oauth/start", {
                method: "POST",
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            deviceLogin.writeStdout("https://auth.openai.com/codex/device\nTEST-12345\n")
            await pendingResponse

            writeCodexChatGptAuthFileSync({
                env: { CODEX_HOME: codexHome },
                tokens: {
                    idToken: fakeJwt({}),
                    accessToken: fakeJwt({}),
                    refreshToken: "refresh-token",
                    accountId: "account-1",
                },
            })

            const response = await handler(new Request("http://backend/codex/oauth/status", {
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            const body = await response!.json() as Record<string, unknown>

            expect(response!.status).toBe(200)
            expect(body.status).toBe("complete")
            expect(body.ready).toBe(true)
            expect(body.accountId).toBe("account-1")
            expect(body.message).toBe("Codex ChatGPT login is active")
            expect(deviceLogin.kill).toHaveBeenCalledWith("SIGTERM")
            expect(persistChatGptAuth).toHaveBeenCalledTimes(1)
            expect(persistChatGptAuth.mock.calls[0]?.[0]).toMatchObject({
                accountId: "account-1",
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("fails closed when Codex device auth falls back to localhost callback login", async () => {
        const codexHome = createTempCodexHome()
        const deviceLogin = new FakeCodexDeviceLoginProcess()
        const handler = createCodexOAuthControlHandler({
            serviceToken: "service-token",
            env: { CODEX_HOME: codexHome },
            spawnDeviceLogin: vi.fn(() => deviceLogin),
        })

        try {
            const pendingResponse = handler(new Request("http://backend/codex/oauth/start", {
                method: "POST",
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            deviceLogin.writeStdout("Open http://localhost:1455/auth/callback after signing in")
            const response = await pendingResponse
            const body = await response!.json() as Record<string, unknown>

            expect(response!.status).toBe(200)
            expect(body.status).toBe("failed")
            expect(body.ready).toBe(false)
            expect(body.message).toBe("Codex device-code login is unavailable; browser/localhost callback login is disabled")
            expect(deviceLogin.kill).toHaveBeenCalledWith("SIGTERM")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("reports sanitized Codex CLI output when device login exits early", async () => {
        const codexHome = createTempCodexHome()
        const deviceLogin = new FakeCodexDeviceLoginProcess()
        const handler = createCodexOAuthControlHandler({
            serviceToken: "service-token",
            env: { CODEX_HOME: codexHome },
            spawnDeviceLogin: vi.fn(() => deviceLogin),
        })

        try {
            const pendingResponse = handler(new Request("http://backend/codex/oauth/start", {
                method: "POST",
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            deviceLogin.writeStderr("error: unexpected argument '--device-auth' after code TEST-12345")
            deviceLogin.close(1)
            const response = await pendingResponse
            const body = await response!.json() as Record<string, unknown>

            expect(response!.status).toBe(200)
            expect(body.status).toBe("failed")
            expect(body.message).toBe("Codex device-code login ended before ChatGPT authorized the backend (exit code 1): error: unexpected argument '--device-auth' after code <redacted-code>")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})

function createTempCodexHome(): string {
    return mkdtempSync(join(tmpdir(), "valiq-codex-oauth-"))
}

class FakeCodexDeviceLoginProcess extends EventEmitter {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    readonly kill = vi.fn((_signal?: NodeJS.Signals) => true)

    writeStdout(value: string): void {
        this.stdout.emit("data", value)
    }

    writeStderr(value: string): void {
        this.stderr.emit("data", value)
    }

    close(code: number | null, signal: NodeJS.Signals | null = null): void {
        this.emit("close", code, signal)
    }
}

function fakeJwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".")
}
