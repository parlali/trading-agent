import { describe, expect, it } from "vitest"
import type { MT5Policy } from "@valiq-trading/core"
import {
    resolveMT5AllowedSymbol,
    resolveMT5AllowedSymbols,
    resolveMT5ConfiguredSymbols,
} from "./symbols"
import { resolveMT5InstrumentRegions } from "./market-context"

describe("MT5 symbol configuration", () => {
    it("uses exact broker symbols without falling back to trading-hour aliases", () => {
        expect(resolveMT5ConfiguredSymbols(createPolicy())).toEqual([])
        expect(resolveMT5ConfiguredSymbols(createPolicy({
            "XAUUSD.ecn": ["US"],
            " EURUSD ": ["EU"],
        }))).toEqual(["EURUSD", "XAUUSD.ecn"])
        expect(Object.keys(resolveMT5InstrumentRegions(createPolicy({
            "XAUUSD.ecn": ["US"],
        })))).toEqual(["XAUUSD.ecn"])
    })

    it("fails closed when no configured broker symbols are available", () => {
        expect(() => resolveMT5AllowedSymbol("XAUUSD", [])).toThrow("no configured provider-verified symbols")
        expect(() => resolveMT5AllowedSymbol("XAUUSD", ["XAUUSD.ecn"])).toThrow("outside the configured provider-verified symbol set")
        expect(resolveMT5AllowedSymbol("xauusd.ecn", ["XAUUSD.ecn"])).toBe("XAUUSD.ecn")
    })

    it("rejects ambiguous configured broker symbols", () => {
        expect(() => resolveMT5AllowedSymbols(["XAUUSD.ecn", "xauusd.ECN"])).toThrow("duplicate provider symbols")
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
