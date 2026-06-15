import { describe, expect, it } from "vitest"
import { getRecentAlerts } from "../../convex/lib/queries/system"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("system queries", () => {
    it("continues paginating recent alerts until enough filtered matches are found", async () => {
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
