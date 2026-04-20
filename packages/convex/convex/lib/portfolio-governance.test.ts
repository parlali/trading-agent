import { describe, expect, it } from "vitest"
import { portfolioGovernanceTestables } from "./mutations/portfolio"

describe("portfolio governance helpers", () => {
    it("collects expected external instruments from strategy safety policies", () => {
        const expected = portfolioGovernanceTestables.collectExpectedExternalInstruments([
            {
                _id: "strategy-a",
                policy: {
                    safety: {
                        expectedExternalInstruments: ["  XAUUSD  ", "BTC-USDT-SWAP", "XAUUSD"],
                    },
                },
            },
            {
                _id: "strategy-b",
                policy: {
                    safety: {
                        expectedExternalInstruments: ["US30.cash"],
                    },
                },
            },
        ] as never)

        expect(Array.from(expected).sort()).toEqual([
            "BTC-USDT-SWAP",
            "US30.cash",
            "XAUUSD",
        ])
    })

    it("keeps MT5 provider-position ownership stable for ticket 1600791764 across sync/restart", () => {
        const positionKey = portfolioGovernanceTestables.buildPositionKey({
            instrument: "XAUUSD",
            providerPositionId: undefined,
            metadata: JSON.stringify({ ticket: 1600791764 }),
            side: "long",
        })

        expect(positionKey).toBe("XAUUSD:1600791764")

        const strategyId = "strategy-a"
        const resolvedFromClaim = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey,
            claimsByInstrument: new Map([["XAUUSD", new Set([strategyId])]]),
            existingPositionByKey: new Map(),
            strategyMap: new Map([[strategyId, { _id: strategyId }]]),
        } as never)

        expect(resolvedFromClaim).toEqual({
            strategyId,
            ownershipStatus: "owned",
        })

        const resolvedAfterRestart = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey,
            claimsByInstrument: new Map(),
            existingPositionByKey: new Map([
                [positionKey, {
                    strategyId,
                }],
            ]),
            strategyMap: new Map([[strategyId, { _id: strategyId }]]),
        } as never)

        expect(resolvedAfterRestart).toEqual({
            strategyId,
            ownershipStatus: "owned",
        })

        const secondKey = portfolioGovernanceTestables.buildPositionKey({
            instrument: "XAUUSD",
            providerPositionId: undefined,
            metadata: JSON.stringify({ ticket: 1600791765 }),
            side: "long",
        })
        expect(secondKey).toBe("XAUUSD:1600791765")
        expect(secondKey).not.toBe(positionKey)
    })

    it("infers MT5 closed-order fill from provider ticket match and cancels stale unmatched rows", () => {
        const order = {
            orderId: "1600791764",
            action: "entry",
            quantity: 0.01,
            filledQuantity: 0,
            avgFillPrice: undefined,
            instrument: "XAUUSD",
            intent: {
                side: "buy",
            },
        }

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "mt5",
            order,
            livePositions: [
                {
                    instrument: "XAUUSD",
                    side: "long",
                    quantity: 0.01,
                    entryPrice: 3200,
                    metadata: JSON.stringify({ ticket: 1600791764 }),
                },
            ],
        } as never)

        expect(inferredFill.status).toBe("filled")
        expect(inferredFill.filledQuantity).toBe(0.01)
        expect(inferredFill.avgFillPrice).toBe(3200)

        const staleRow = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "mt5",
            order,
            livePositions: [],
        } as never)

        expect(staleRow.status).toBe("cancelled")
    })

    it("marks manual external instruments as expected and non-blocking when unowned", () => {
        const expectedExternal = portfolioGovernanceTestables.collectExpectedExternalInstruments([
            {
                _id: "strategy-manual",
                policy: {
                    safety: {
                        expectedExternalInstruments: ["GREENLAND-MANUAL"],
                    },
                },
            },
        ] as never)

        const ownership = portfolioGovernanceTestables.resolveOwnership({
            instrument: "GREENLAND-MANUAL",
            claimsByInstrument: new Map(),
        } as never)

        const flaggedAsExpectedExternal = ownership.ownershipStatus !== "owned" && expectedExternal.has("GREENLAND-MANUAL")
        expect(ownership.ownershipStatus).toBe("unowned")
        expect(flaggedAsExpectedExternal).toBe(true)
    })
})
