import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
    extractCodexChatGptAccountId,
    inspectCodexChatGptAuthStatusSync,
    writeCodexChatGptAuthFileSync,
} from "./codex-auth"

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id"

describe("Codex ChatGPT auth file", () => {
    it("reports missing login when auth.json is absent", () => {
        const codexHome = createTempCodexHome()

        try {
            const status = inspectCodexChatGptAuthStatusSync({ CODEX_HOME: codexHome })

            expect(status.ready).toBe(false)
            expect(status.status).toBe("missing")
            expect(status.authFilePath).toBe(join(codexHome, "auth.json"))
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("writes and inspects a Codex CLI-compatible ChatGPT auth file", () => {
        const codexHome = createTempCodexHome()

        try {
            const status = writeCodexChatGptAuthFileSync({
                env: { CODEX_HOME: codexHome },
                refreshedAt: new Date("2026-06-09T00:00:00.000Z"),
                tokens: {
                    idToken: "id-token",
                    accessToken: fakeJwt({ [ACCOUNT_ID_CLAIM]: "account-1" }),
                    refreshToken: "refresh-token",
                    accountId: "account-1",
                },
            })
            const authFile = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as Record<string, unknown>

            expect(status.ready).toBe(true)
            expect(status.accountId).toBe("account-1")
            expect(authFile.auth_mode).toBe("chatgpt")
            expect(authFile.OPENAI_API_KEY).toBeNull()
            expect(authFile.last_refresh).toBe("2026-06-09T00:00:00.000Z")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("fails readiness for incomplete ChatGPT auth files", () => {
        const codexHome = createTempCodexHome()

        try {
            writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
                auth_mode: "chatgpt",
                tokens: {
                    access_token: "access-token",
                },
            }))

            const status = inspectCodexChatGptAuthStatusSync({ CODEX_HOME: codexHome })

            expect(status.ready).toBe(false)
            expect(status.status).toBe("invalid")
            expect(status.message).toContain("incomplete")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("extracts the ChatGPT account id claim from access tokens", () => {
        expect(extractCodexChatGptAccountId(fakeJwt({ [ACCOUNT_ID_CLAIM]: "account-1" }))).toBe("account-1")
        expect(extractCodexChatGptAccountId("not-a-jwt")).toBeNull()
    })
})

function createTempCodexHome(): string {
    return mkdtempSync(join(tmpdir(), "valiq-codex-auth-"))
}

function fakeJwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".")
}
