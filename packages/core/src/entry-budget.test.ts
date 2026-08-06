import { describe, expect, it } from "vitest"
import { isWeeklyEntryBudgetExhausted } from "./entry-budget"

describe("isWeeklyEntryBudgetExhausted", () => {
    it("reports exhausted only at or past the weekly cap", () => {
        const base = { byInstrument: new Map<string, number>(), weekStartAt: 0 }
        expect(isWeeklyEntryBudgetExhausted({ counts: { ...base, total: 8 }, maxEntriesPerWeek: 8 })).toBe(true)
        expect(isWeeklyEntryBudgetExhausted({ counts: { ...base, total: 7 }, maxEntriesPerWeek: 8 })).toBe(false)
        expect(isWeeklyEntryBudgetExhausted({ counts: { ...base, total: 99 } })).toBe(false)
    })
})
