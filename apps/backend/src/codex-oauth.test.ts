import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
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
            expect(body.message).toBe("Codex ChatGPT login is missing")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it("rejects dashboard start instead of returning a non-completable OAuth URL", async () => {
        const codexHome = createTempCodexHome()
        const logger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }
        const handler = createCodexOAuthControlHandler({
            serviceToken: "service-token",
            env: { CODEX_HOME: codexHome },
            logger,
        })

        try {
            const response = await handler(new Request("http://backend/codex/oauth/start", {
                method: "POST",
                headers: {
                    authorization: "Bearer service-token",
                },
            }))
            const body = await response!.json() as Record<string, unknown>

            expect(response!.status).toBe(400)
            expect(String(body.error)).toContain("dashboard login cannot start")
            expect(String(body.error)).toContain("Refusing to start a non-completable login flow")
            expect(logger.warn).toHaveBeenCalledWith("Codex OAuth control request failed", expect.objectContaining({
                path: "/codex/oauth/start",
            }))
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})

function createTempCodexHome(): string {
    return mkdtempSync(join(tmpdir(), "valiq-codex-oauth-"))
}
