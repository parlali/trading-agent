import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isWithinSessionFlatWindow } from "./runtime-time"

const mt5Session = {
    start: "07:00",
    end: "21:00",
    timezone: "UTC",
    closeBufferMinutes: 15,
}

function atUtc(time: string): void {
    vi.setSystemTime(new Date(`2026-07-01T${time}:00Z`))
}

describe("isWithinSessionFlatWindow", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("does not flatten during the tradable window", () => {
        for (const time of ["07:00", "12:30", "20:42", "20:44"]) {
            atUtc(time)
            expect(isWithinSessionFlatWindow(mt5Session).shouldFlatten).toBe(false)
        }
    })

    it("flattens inside the close buffer", () => {
        for (const time of ["20:45", "20:46", "20:59"]) {
            atUtc(time)
            expect(isWithinSessionFlatWindow(mt5Session).shouldFlatten).toBe(true)
        }
    })

    it("flattens for runs that start after the session end", () => {
        for (const time of ["21:00", "21:04", "21:42", "23:30", "02:00", "06:59"]) {
            atUtc(time)
            expect(isWithinSessionFlatWindow(mt5Session).shouldFlatten).toBe(true)
        }
    })

    it("handles overnight sessions", () => {
        const overnight = {
            start: "22:00",
            end: "06:00",
            timezone: "UTC",
            closeBufferMinutes: 30,
        }

        atUtc("23:00")
        expect(isWithinSessionFlatWindow(overnight).shouldFlatten).toBe(false)
        atUtc("03:00")
        expect(isWithinSessionFlatWindow(overnight).shouldFlatten).toBe(false)
        atUtc("05:31")
        expect(isWithinSessionFlatWindow(overnight).shouldFlatten).toBe(true)
        atUtc("12:00")
        expect(isWithinSessionFlatWindow(overnight).shouldFlatten).toBe(true)
    })
})
