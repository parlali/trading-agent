import { describe, expect, it } from "vitest"
import { resolveProviderAdoptionInstruments } from "./provider-adoption"

describe("resolveProviderAdoptionInstruments", () => {
    it("fails closed when another strategy still has an active claim", () => {
        expect(() => resolveProviderAdoptionInstruments({
            targetStrategyId: "strategy-a",
            requestedInstruments: ["XAUUSD"],
            rows: [
                {
                    instrument: "XAUUSD",
                    ownershipStatus: "unowned",
                },
            ],
            claims: [
                {
                    instrument: "XAUUSD",
                    strategyId: "strategy-b",
                },
            ],
        })).toThrow("active claim belongs to another strategy")
    })

    it("rejects instruments that mix owned and unowned exposure rows", () => {
        expect(() => resolveProviderAdoptionInstruments({
            targetStrategyId: "strategy-a",
            requestedInstruments: ["BTC"],
            rows: [
                {
                    instrument: "BTC",
                    ownershipStatus: "unowned",
                },
                {
                    instrument: "BTC",
                    ownershipStatus: "owned",
                    strategyId: "strategy-b",
                },
            ],
        })).toThrow("mixed ownership detected")
    })

    it("rejects operator selections that do not exactly match the current exposure set", () => {
        expect(() => resolveProviderAdoptionInstruments({
            targetStrategyId: "strategy-a",
            requestedInstruments: ["ETH", "DOGE"],
            rows: [
                {
                    instrument: "ETH",
                    ownershipStatus: "unowned",
                },
                {
                    instrument: "SOL",
                    ownershipStatus: "orphaned",
                },
            ],
        })).toThrow("Requested instruments must exactly match the current unowned exposure set")
    })
})
