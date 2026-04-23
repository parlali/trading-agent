import { describe, expect, it, vi, afterEach } from "vitest"
import { isWithinSessionFlatWindow } from "./runtime"

afterEach(() => {
    vi.restoreAllMocks()
})

describe("isWithinSessionFlatWindow", () => {
    it("returns true when current time is within configured close buffer", () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1, 15, 50, 0))

        const result = isWithinSessionFlatWindow({
            end: "16:00",
            timezone: "UTC",
            closeBufferMinutes: 15,
        })

        expect(result.shouldFlatten).toBe(true)
        expect(result.currentTime).toBe("15:50")
    })

    it("returns false when current time is before the flatten buffer", () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1, 15, 30, 0))

        const result = isWithinSessionFlatWindow({
            end: "16:00",
            timezone: "UTC",
            closeBufferMinutes: 15,
        })

        expect(result.shouldFlatten).toBe(false)
    })

    it("returns false once the session end minute is reached", () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1, 16, 0, 0))

        const result = isWithinSessionFlatWindow({
            end: "16:00",
            timezone: "UTC",
            closeBufferMinutes: 15,
        })

        expect(result.shouldFlatten).toBe(false)
    })
})
