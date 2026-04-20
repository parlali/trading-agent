import { describe, expect, it, vi, afterEach } from "vitest"
import { isWithinSessionFlatWindow } from "./runtime"

afterEach(() => {
    vi.useRealTimers()
})

describe("isWithinSessionFlatWindow", () => {
    it("returns true when current time is within configured close buffer", () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-01-01T15:50:00.000Z"))

        const result = isWithinSessionFlatWindow({
            end: "16:00",
            timezone: "UTC",
            closeBufferMinutes: 15,
        })

        expect(result.shouldFlatten).toBe(true)
        expect(result.currentTime).toBe("15:50")
    })

    it("returns false when current time is before the flatten buffer", () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-01-01T15:30:00.000Z"))

        const result = isWithinSessionFlatWindow({
            end: "16:00",
            timezone: "UTC",
            closeBufferMinutes: 15,
        })

        expect(result.shouldFlatten).toBe(false)
    })

    it("returns false once the session end minute is reached", () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-01-01T16:00:00.000Z"))

        const result = isWithinSessionFlatWindow({
            end: "16:00",
            timezone: "UTC",
            closeBufferMinutes: 15,
        })

        expect(result.shouldFlatten).toBe(false)
    })
})
