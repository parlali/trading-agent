import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { TradingBackendClient } from "@valiq-trading/convex"
import { writeCodexChatGptAuthFileSync, readCodexChatGptAuthFileSync } from "./codex-auth"
import { restoreCodexChatGptAuthFromControlPlane } from "./codex-auth-persistence"

describe("Codex auth persistence", () => {
    it("restores persisted auth when it is newer than the local auth file", async () => {
        const codexHome = mkTempCodexHome()
        const env = { CODEX_HOME: codexHome }
        writeCodexChatGptAuthFileSync({
            env,
            refreshedAt: new Date("2026-06-19T16:00:00.000Z"),
            tokens: {
                idToken: "old-id",
                accessToken: "old-access",
                refreshToken: "refresh",
                accountId: "account-1",
            },
        })
        const persistedHome = mkTempCodexHome()
        const persistedEnv = { CODEX_HOME: persistedHome }
        writeCodexChatGptAuthFileSync({
            env: persistedEnv,
            refreshedAt: new Date("2026-06-21T21:00:00.000Z"),
            tokens: {
                idToken: "new-id",
                accessToken: "new-access",
                refreshToken: "refresh",
                accountId: "account-1",
            },
        })
        const persisted = readCodexChatGptAuthFileSync(persistedEnv)

        try {
            await restoreCodexChatGptAuthFromControlPlane({
                env,
                backend: {
                    getCodexChatGptAuth: vi.fn(async () => ({
                        authJson: persisted!.authJson,
                        accountId: persisted!.accountId,
                        lastRefresh: persisted!.lastRefresh,
                        updatedAt: Date.now(),
                    })),
                } as unknown as TradingBackendClient,
                logger: createLogger(),
            })

            expect(readCodexChatGptAuthFileSync(env)?.lastRefresh).toBe("2026-06-21T21:00:00.000Z")
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(persistedHome, { recursive: true, force: true })
        }
    })
})

function mkTempCodexHome(): string {
    return mkdtempSync(join(tmpdir(), "valiq-codex-auth-persistence-"))
}

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
    }
}
