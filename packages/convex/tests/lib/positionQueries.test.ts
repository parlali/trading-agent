import { describe, expect, it } from "vitest"
import { getStrategyPositionsForRun } from "../../convex/lib/queries/positions"
import {
    callRegisteredQuery,
    type FakeRow,
} from "./fakeQueryDb"

describe("position queries", () => {
    it("returns the position sync batch whose dry-run ledger sourceRunId matches the run", async () => {
        const rows = await callGetStrategyPositionsForRun({
            strategyId: "strategy-1",
            runId: "run-1",
            rows: {
                position_syncs: [
                    {
                        _id: "sync-match",
                        strategyId: "strategy-1",
                        syncedAt: 10,
                        positionCount: 2,
                    },
                    {
                        _id: "sync-other",
                        strategyId: "strategy-1",
                        syncedAt: 20,
                        positionCount: 2,
                    },
                ],
                positions: [
                    createLedgerPosition("ledger-other", 20, "other-run"),
                    createMarketPosition("TOKEN-OTHER", 20),
                    createLedgerPosition("ledger-match", 10, "run-1"),
                    createMarketPosition("TOKEN-MATCH", 10),
                ],
            },
        }) as FakeRow[]

        expect(rows.map((row) => row._id).sort()).toEqual([
            "ledger-match",
            "position-TOKEN-MATCH",
        ])
    })

    it("rejects invalid run-position scan limits", async () => {
        await expect(callGetStrategyPositionsForRun({
            strategyId: "strategy-1",
            runId: "run-1",
            maxSyncs: 0,
            rows: {},
        })).rejects.toThrow("maxSyncs must be a positive integer between 1 and 1000")
        await expect(callGetStrategyPositionsForRun({
            strategyId: "strategy-1",
            runId: "run-1",
            maxSyncs: 1001,
            rows: {},
        })).rejects.toThrow("maxSyncs must be a positive integer between 1 and 1000")
    })
})

async function callGetStrategyPositionsForRun(args: {
    strategyId: string
    runId: string
    maxSyncs?: number
    rows: Record<string, FakeRow[]>
}): Promise<unknown> {
    return await callRegisteredQuery(getStrategyPositionsForRun, args.rows, {
        strategyId: args.strategyId,
        runId: args.runId,
        maxSyncs: args.maxSyncs,
    })
}

function createLedgerPosition(id: string, syncedAt: number, sourceRunId: string): FakeRow {
    return {
        _id: id,
        strategyId: "strategy-1",
        syncedAt,
        instrument: "__DRY_RUN_ACCOUNT_LEDGER__",
        metadata: JSON.stringify({
            dryRunLedger: true,
            sourceRunId,
        }),
    }
}

function createMarketPosition(instrument: string, syncedAt: number): FakeRow {
    return {
        _id: `position-${instrument}`,
        strategyId: "strategy-1",
        syncedAt,
        instrument,
        metadata: "{}",
    }
}
