import { describe, expect, it } from "vitest"
import { getTradeEvents } from "../../convex/lib/queries/orders"
import {
    getAgentLogs,
    getRunHistory,
} from "../../convex/lib/queries/runs"
import {
    callRegisteredQuery,
    type FakeRow,
} from "./fakeQueryDb"

describe("run queries", () => {
    it("caps getRunHistory limits at the canonical audit query bound", async () => {
        const result = await callGetRunHistory({
            strategyId: "strategy-1",
            limit: 999,
        }) as FakeRow[]

        expect(result).toHaveLength(500)
        expect(result[0]?._id).toBe("run-599")
        expect(result[499]?._id).toBe("run-100")
    })

    it("rejects invalid getRunHistory limits", async () => {
        await expect(callGetRunHistory({
            strategyId: "strategy-1",
            limit: 0,
        })).rejects.toThrow("getRunHistory limit must be a positive integer")
        await expect(callGetRunHistory({
            strategyId: "strategy-1",
            limit: 1.5,
        })).rejects.toThrow("getRunHistory limit must be a positive integer")
    })

    it("returns bounded run evidence rows without truncating", async () => {
        const agentLogs = await callRunEvidenceQuery(getAgentLogs, {
            agent_logs: [
                {
                    _id: "log-1",
                    runId: "run-1",
                    sequence: 1,
                },
            ],
        }) as FakeRow[]
        const tradeEvents = await callRunEvidenceQuery(getTradeEvents, {
            trade_events: [
                {
                    _id: "event-1",
                    runId: "run-1",
                    timestamp: 1,
                },
            ],
        }) as FakeRow[]

        expect(agentLogs.map((row) => row._id)).toEqual(["log-1"])
        expect(tradeEvents.map((row) => row._id)).toEqual(["event-1"])
    })

    it("fails closed when run evidence exceeds the export row bound", async () => {
        await expect(callRunEvidenceQuery(getAgentLogs, {
            agent_logs: Array.from({ length: 5001 }, (_, index) => ({
                _id: `log-${index}`,
                runId: "run-1",
                sequence: index,
            })),
        })).rejects.toThrow("agent logs for run run-1 exceeds run evidence row limit 5000")
        await expect(callRunEvidenceQuery(getTradeEvents, {
            trade_events: Array.from({ length: 5001 }, (_, index) => ({
                _id: `event-${index}`,
                runId: "run-1",
                timestamp: index,
            })),
        })).rejects.toThrow("trade events for run run-1 exceeds run evidence row limit 5000")
    })
})

async function callGetRunHistory(args: {
    strategyId: string
    limit?: number
}): Promise<unknown> {
    return await callRegisteredQuery(getRunHistory, {
        strategy_runs: Array.from({ length: 600 }, (_, index) => ({
            _id: `run-${index}`,
            strategyId: "strategy-1",
            startedAt: index,
        })),
    }, args)
}

async function callRunEvidenceQuery(
    registered: unknown,
    rows: Record<string, FakeRow[]>
): Promise<unknown> {
    return await callRegisteredQuery(registered, rows, {
        runId: "run-1",
    })
}
