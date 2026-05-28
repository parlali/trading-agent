import { describe, expect, it } from "vitest"
import { resolveProviderAdoptionInstruments } from "./provider-adoption"

describe("resolveProviderAdoptionInstruments", () => {
    it("fails closed for conflicted, mixed, or incomplete provider-adoption selections", () => {
        const cases = [
            {
                args: {
                    targetStrategyId: "strategy-a",
                    requestedInstruments: ["XAUUSD"],
                    rows: [
                        {
                            instrument: "XAUUSD",
                            ownershipStatus: "unowned" as const,
                        },
                    ],
                    claims: [
                        {
                            instrument: "XAUUSD",
                            strategyId: "strategy-b",
                        },
                    ],
                },
                reason: "active claim belongs to another strategy",
            },
            {
                args: {
                    targetStrategyId: "strategy-a",
                    requestedInstruments: ["BTC"],
                    rows: [
                        {
                            instrument: "BTC",
                            ownershipStatus: "unowned" as const,
                        },
                        {
                            instrument: "BTC",
                            ownershipStatus: "owned" as const,
                            strategyId: "strategy-b",
                        },
                    ],
                },
                reason: "mixed ownership detected",
            },
            {
                args: {
                    targetStrategyId: "strategy-a",
                    requestedInstruments: ["ETH", "DOGE"],
                    rows: [
                        {
                            instrument: "ETH",
                            ownershipStatus: "unowned" as const,
                        },
                        {
                            instrument: "SOL",
                            ownershipStatus: "orphaned" as const,
                        },
                    ],
                },
                reason: "Requested instruments must exactly match the current unowned exposure set",
            },
        ]

        for (const testCase of cases) {
            expect(() => resolveProviderAdoptionInstruments(testCase.args)).toThrow(testCase.reason)
        }
    })
})
