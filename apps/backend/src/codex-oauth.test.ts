import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { inspectCodexChatGptAuthStatusSync } from "./codex-auth"
import { CodexOAuthController, extractAuthorizationCode, resolveOAuthRedirectUri } from "./codex-oauth"

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id"

describe("Codex OAuth flow", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("requires a full redirect URL with matching state", () => {
        expect(extractAuthorizationCode("http://localhost:1455/auth/callback?code=abc&state=state-1", "state-1")).toBe("abc")
        expect(() => extractAuthorizationCode("abc", "state-1")).toThrow("full ChatGPT redirect URL")
        expect(() => extractAuthorizationCode("http://localhost:1455/auth/callback?code=abc&state=other", "state-1")).toThrow("state did not match")
    })

    it("validates hosted OAuth redirect URIs", () => {
        expect(resolveOAuthRedirectUri("https://dashboard.example.com/api/codex-oauth/callback")).toBe("https://dashboard.example.com/api/codex-oauth/callback")
        expect(resolveOAuthRedirectUri("http://localhost:1455/auth/callback")).toBe("http://localhost:1455/auth/callback")
        expect(() => resolveOAuthRedirectUri("http://dashboard.example.com/api/codex-oauth/callback")).toThrow("must use https")
    })

    it("exchanges the redirect URL with the session redirect URI and writes Codex auth.json", async () => {
        const codexHome = createTempCodexHome()
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            id_token: fakeJwt({ [ACCOUNT_ID_CLAIM]: "account-1" }),
            access_token: fakeJwt({}),
            refresh_token: "refresh-token",
        }), {
            status: 200,
            headers: {
                "content-type": "application/json",
            },
        }))
        vi.stubGlobal("fetch", fetchMock)

        try {
            const controller = new CodexOAuthController({
                env: { CODEX_HOME: codexHome },
            })
            const redirectUri = "https://dashboard.example.com/api/codex-oauth/callback"
            const started = controller.start({ redirectUri })
            const authorizationUrl = new URL(started.authUrl!)
            const state = authorizationUrl.searchParams.get("state")

            expect(started.status).toBe("awaiting_redirect")
            expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri)
            expect(state).toBeTruthy()

            const completed = await controller.submit(`${redirectUri}?code=code-1&state=${state}`)
            const authStatus = inspectCodexChatGptAuthStatusSync({ CODEX_HOME: codexHome })
            const fetchCall = fetchMock.mock.calls[0] as unknown[] | undefined
            const fetchInit = fetchCall?.[1] as RequestInit | undefined
            const fetchBody = fetchInit?.body

            expect(completed.status).toBe("complete")
            expect(completed.ready).toBe(true)
            expect(completed.authUrl).toBeNull()
            expect(authStatus.ready).toBe(true)
            expect(authStatus.accountId).toBe("account-1")
            expect(fetchMock).toHaveBeenCalledTimes(1)
            expect(fetchBody).toBeInstanceOf(URLSearchParams)
            expect((fetchBody as URLSearchParams).get("redirect_uri")).toBe(redirectUri)
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})

function createTempCodexHome(): string {
    return mkdtempSync(join(tmpdir(), "valiq-codex-oauth-"))
}

function fakeJwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".")
}
