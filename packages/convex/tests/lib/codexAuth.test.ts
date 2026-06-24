import { describe, expect, it } from "vitest"
import { storeCodexChatGptAuth } from "../../convex/lib/mutations/codexAuth"
import { callRegistered, FakeMutationDb } from "./fakeMutationDb"

describe("Codex ChatGPT auth persistence", () => {
    it("does not overwrite a newer persisted refresh with an older snapshot", async () => {
        const originalToken = process.env.BACKEND_SERVICE_TOKEN
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            codex_chatgpt_auth: [{
                _id: "auth-1",
                key: "chatgpt",
                authJson: buildAuthJson("newer"),
                accountId: "account-1",
                lastRefresh: "2026-06-21T21:00:00.000Z",
                createdAt: 1,
                updatedAt: 2,
            }],
        })

        try {
            await callRegistered(storeCodexChatGptAuth, { db } as never, {
                serviceToken: "test-token",
                authJson: buildAuthJson("older"),
                accountId: "account-1",
                lastRefresh: "2026-06-21T20:59:00.000Z",
            })

            expect(db.rows.codex_chatgpt_auth?.[0]?.authJson).toBe(buildAuthJson("newer"))
            expect(db.rows.codex_chatgpt_auth?.[0]?.lastRefresh).toBe("2026-06-21T21:00:00.000Z")
        } finally {
            restoreServiceToken(originalToken)
        }
    })

    it("accepts a newer persisted refresh for the same account", async () => {
        const originalToken = process.env.BACKEND_SERVICE_TOKEN
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            codex_chatgpt_auth: [{
                _id: "auth-1",
                key: "chatgpt",
                authJson: buildAuthJson("older"),
                accountId: "account-1",
                lastRefresh: "2026-06-21T20:59:00.000Z",
                createdAt: 1,
                updatedAt: 2,
            }],
        })

        try {
            await callRegistered(storeCodexChatGptAuth, { db } as never, {
                serviceToken: "test-token",
                authJson: buildAuthJson("newer"),
                accountId: "account-1",
                lastRefresh: "2026-06-21T21:00:00.000Z",
            })

            expect(db.rows.codex_chatgpt_auth?.[0]?.authJson).toBe(buildAuthJson("newer"))
            expect(db.rows.codex_chatgpt_auth?.[0]?.lastRefresh).toBe("2026-06-21T21:00:00.000Z")
        } finally {
            restoreServiceToken(originalToken)
        }
    })
})

function buildAuthJson(label: string): string {
    return JSON.stringify({
        label,
    })
}

function restoreServiceToken(originalToken: string | undefined): void {
    if (originalToken === undefined) {
        delete process.env.BACKEND_SERVICE_TOKEN
    } else {
        process.env.BACKEND_SERVICE_TOKEN = originalToken
    }
}
