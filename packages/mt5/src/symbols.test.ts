import { describe, expect, it } from "vitest"
import type { MT5Policy } from "@valiq-trading/core"
import {
    resolveMT5AllowedSymbol,
    resolveMT5ConfiguredSymbols,
} from "./symbols"

describe("MT5 symbol configuration", () => {
    it("uses explicit broker symbols without falling back to trading-hour aliases", () => {
        expect(resolveMT5ConfiguredSymbols(createPolicy())).toEqual([])
        expect(resolveMT5ConfiguredSymbols(createPolicy({
            "xauusd.ecn": ["US"],
            " EURUSD ": ["EU"],
        }))).toEqual(["EURUSD", "XAUUSD.ECN"])
    })

    it("fails closed when no configured broker symbols are available", () => {
        expect(() => resolveMT5AllowedSymbol("XAUUSD", [])).toThrow("no configured provider-verified symbols")
        expect(() => resolveMT5AllowedSymbol("XAUUSD", ["XAUUSD.ECN"])).toThrow("outside the configured provider-verified symbol set")
        expect(resolveMT5AllowedSymbol("xauusd.ecn", ["XAUUSD.ECN"])).toBe("XAUUSD.ECN")
    })
})

function createPolicy(
    marketRegionsByInstrument?: MT5Policy["marketRegionsByInstrument"]
): MT5Policy {
    return {
        llm: {
            provider: "openrouter",
            model: "openai/gpt-5.5",
        },
        maxRiskPercent: 1,
        minRiskReward: 1,
        tradingHours: {
            start: "07:00",
            end: "21:00",
            timezone: "UTC",
        },
        safety: {
            maxDrawdownDay: 3,
            maxDrawdownWeek: 10,
            cooldownMinutesAfterDayBreach: 720,
            cooldownMinutesAfterWeekBreach: 1440,
            strategyTimezone: "UTC",
            sessionFlat: {
                enabled: false,
                closeBufferMinutes: 15,
                timezone: "UTC",
            },
            account: {
                allocationPercent: 100,
            },
            expectedExternalInstruments: [],
        },
        dryRun: false,
        allowMultiplePendingEntryOrdersPerInstrument: false,
        allowOverlappingExposure: false,
        marketRegionsByInstrument,
    }
}
