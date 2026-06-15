import { describe, expect, it } from "vitest"
import { createRun } from "../../convex/lib/mutations/orders"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("strategy run metadata invariants", () => {
    it("rejects chat runs without complete chat metadata", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb(createSeed())

        await expect(callRegistered(createRun, { db } as never, {
            serviceToken: "test-token",
            strategyId: "strategy-1",
            app: "alpaca-options",
            trigger: "chat",
            chatSource: "dashboard",
            chatSessionId: "session-1",
        })).rejects.toThrow("Chat-triggered runs require chatSource, chatSessionId, and chatMessageId")

        expect(db.rows.strategy_runs).toEqual([])
    })

    it("rejects chat metadata on non-chat runs", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb(createSeed())

        await expect(callRegistered(createRun, { db } as never, {
            serviceToken: "test-token",
            strategyId: "strategy-1",
            app: "alpaca-options",
            trigger: "manual",
            chatSource: "dashboard",
            chatSessionId: "session-1",
            chatMessageId: "message-1",
        })).rejects.toThrow("Chat metadata is only allowed when trigger is \"chat\"")

        expect(db.rows.strategy_runs).toEqual([])
    })

    it("persists complete metadata for chat-triggered runs", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb(createSeed())

        await callRegistered(createRun, { db } as never, {
            serviceToken: "test-token",
            strategyId: "strategy-1",
            app: "alpaca-options",
            trigger: "chat",
            chatSource: "dashboard",
            chatSessionId: "session-1",
            chatMessageId: "message-1",
        })

        expect(db.rows.strategy_runs?.[0]).toMatchObject({
            trigger: "chat",
            chatSource: "dashboard",
            chatSessionId: "session-1",
            chatMessageId: "message-1",
        })
    })
})

function createSeed() {
    return {
        strategies: [{
            _id: "strategy-1",
            app: "alpaca-options",
            accountId: "acct-1",
        }],
        strategy_runs: [],
    }
}
