import { describe, expect, it } from "vitest"
import { sanitizeRunSummary } from "./summary-metadata.ts"

describe("sanitizeRunSummary", () => {
    it("removes leading internal reasoning and metadata blocks from persisted summaries", () => {
        const summary = [
            "thought: need to browse three more feeds before deciding",
            "",
            "Open BTC short remains intact with stop at 101250 and take profit at 98500.",
            "",
            "---METADATA---",
            '{"nextRunInMinutes":5}',
            "---END METADATA---",
        ].join("\n")

        expect(sanitizeRunSummary(summary)).toBe(
            "Open BTC short remains intact with stop at 101250 and take profit at 98500."
        )
    })

    it("returns an explicit audit note when the model produced only internal reasoning", () => {
        const summary = [
            "<analysis>",
            "Thought: keep researching",
            "</analysis>",
        ].join("\n")

        expect(sanitizeRunSummary(summary)).toBe(
            "Summary unavailable after sanitization because the model returned internal reasoning instead of an operational handoff."
        )
    })
})
