import { describe, expect, it } from "vitest"
import { updateRun } from "../../convex/lib/mutations/orders"
import { getRunById } from "../../convex/lib/queries/runs"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"
import {
    callRegisteredQuery,
    type FakeRow,
} from "./fakeQueryDb"

describe("run decision record persistence", () => {
    it("persists decisionRecord through updateRun and reads it back", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategy_runs: [{
                _id: "run-1",
                strategyId: "strategy-1",
                app: "okx-swap",
                status: "running",
                startedAt: 1,
            }],
            orders: [],
        })
        const decisionRecord = {
            forecast: {
                direction: "long" as const,
                p: 0.61,
                expectedMove: "+0.9%",
                horizon: "1h",
                invalidation: "Lose the prior low.",
            },
            decision: "no_trade" as const,
            detail: "sit out because the spread is wider than the setup can carry",
            rulesApplied: [
                "Treat venue-owned market data as execution truth.",
            ],
            notInText: [
                "The spread instability is a judgment from the live order book.",
            ],
        }

        await callRegistered(updateRun, { db } as never, {
            serviceToken: "test-token",
            runId: "run-1",
            status: "completed",
            summary: "completed",
            diagnostics: {
                decisionRecord,
            },
        })
        const run = await callRegisteredQuery(getRunById, db.rows, {
            runId: "run-1",
        }) as FakeRow

        expect(run.decisionRecord).toEqual(decisionRecord)
    })
})
