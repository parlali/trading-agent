import { describe, expect, it } from "vitest"
import { logAgentMessages } from "../../convex/lib/mutations/orders"
import { callRegistered, FakeMutationDb } from "./fakeMutationDb"

describe("agent log batch mutation", () => {
    it("inserts batch entries and rejects batches over 50", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            agent_logs: [],
        })

        const result = await callRegistered(logAgentMessages, { db } as never, {
            serviceToken: "test-token",
            entries: [{
                runId: "run-1",
                strategyId: "strategy-1",
                sequence: 1,
                role: "assistant",
                content: "first",
            }, {
                runId: "run-1",
                strategyId: "strategy-1",
                sequence: 2,
                role: "tool",
                content: "second",
                toolName: "lookup",
                toolInput: "{}",
                toolOutput: "{\"ok\":true}",
            }],
        }) as Array<{ sequence: number; timestamp: number }>

        expect(db.rows.agent_logs).toHaveLength(2)
        expect(db.rows.agent_logs?.map((row) => row.sequence)).toEqual([1, 2])
        expect(result.map((row) => row.sequence)).toEqual([1, 2])
        expect(result.every((row) => typeof row.timestamp === "number")).toBe(true)

        await expect(callRegistered(logAgentMessages, { db } as never, {
            serviceToken: "test-token",
            entries: Array.from({ length: 51 }, (_, index) => ({
                runId: "run-1",
                strategyId: "strategy-1",
                sequence: index + 3,
                role: "assistant",
                content: `message-${index}`,
            })),
        }))
            .rejects
            .toThrow("at most 50 entries")
    })
})
