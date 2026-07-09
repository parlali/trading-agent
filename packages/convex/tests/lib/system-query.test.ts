import { describe, expect, it } from "vitest"
import { getRecentAlerts, listAppsWithPendingManualRunRequests } from "../../convex/lib/queries/system"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("system queries", () => {
    it("returns recent alerts through the exact filtered index", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            alerts: [
                createAlert("old-match-1", "critical", false, 1),
                createAlert("old-match-2", "critical", false, 2),
                ...Array.from({ length: 450 }, (_, index) =>
                    createAlert(`new-noise-${index}`, "warning", true, 100 + index)
                ),
            ],
        })

        const rows = await callRegistered(getRecentAlerts, { db } as never, {
            serviceToken: "test-token",
            severity: "critical",
            acknowledged: false,
            limit: 2,
        }) as Array<{ message: string }>

        expect(rows.map((row) => row.message)).toEqual([
            "old-match-2",
            "old-match-1",
        ])
    })

    it("returns only apps with pending manual run requests", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            manual_run_requests: [{
                _id: "manual-pending-alpaca",
                app: "alpaca-options",
                strategyId: "strategy-alpaca",
                requestedAt: 1,
                attemptCount: 0,
            }, {
                _id: "manual-terminal-mt5",
                app: "mt5",
                strategyId: "strategy-mt5",
                requestedAt: 2,
                attemptCount: 1,
                terminalAt: 3,
            }, {
                _id: "manual-pending-okx",
                app: "okx-swap",
                strategyId: "strategy-okx",
                requestedAt: 4,
                attemptCount: 0,
            }],
        })

        const apps = await callRegistered(listAppsWithPendingManualRunRequests, { db } as never, {
            serviceToken: "test-token",
        })

        expect(apps).toEqual(["alpaca-options", "okx-swap"])
    })
})

function createAlert(
    message: string,
    severity: string,
    acknowledged: boolean,
    timestamp: number
) {
    return {
        _id: `alert-${message}`,
        severity,
        acknowledged,
        message,
        timestamp,
    }
}
