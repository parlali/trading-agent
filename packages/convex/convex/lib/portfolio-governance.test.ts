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
        const positionKey = portfolioGovernanceTestables.buildProviderPositionKey({
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

        const secondKey = portfolioGovernanceTestables.buildProviderPositionKey({
            instrument: "XAUUSD",
            providerPositionId: undefined,
            metadata: JSON.stringify({ ticket: 1600791765 }),
            side: "long",
        })
        expect(secondKey).toBe("XAUUSD:1600791765")
        expect(secondKey).not.toBe(positionKey)
    })

    it("resolves same-instrument A/B positions by provider-position claim keys", () => {
        const strategyA = "strategy-a"
        const strategyB = "strategy-b"
        const strategyMap = new Map([
            [strategyA, { _id: strategyA }],
            [strategyB, { _id: strategyB }],
        ])
        const claimsByInstrument = new Map([
            ["XAUUSD", new Set([strategyA, strategyB])],
        ])
        const claimsByPositionKey = new Map([
            ["XAUUSD:1600791764", new Set([strategyA])],
            ["XAUUSD:1600791765", new Set([strategyB])],
        ])

        const resolvedA = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey: "XAUUSD:1600791764",
            claimsByInstrument,
            claimsByPositionKey,
            strategyMap,
        } as never)
        const resolvedB = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey: "XAUUSD:1600791765",
            claimsByInstrument,
            claimsByPositionKey,
            strategyMap,
        } as never)

        expect(resolvedA).toEqual({
            strategyId: strategyA,
            ownershipStatus: "owned",
        })
        expect(resolvedB).toEqual({
            strategyId: strategyB,
            ownershipStatus: "owned",
        })
    })

    it("fails closed when a provider row owner conflicts with a provider-position claim", () => {
        const strategyA = "strategy-a"
        const strategyB = "strategy-b"
        const strategyMap = new Map([
            [strategyA, { _id: strategyA }],
            [strategyB, { _id: strategyB }],
        ])
        const positionKey = "XAUUSD:1600791764"

        const resolved = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey,
            claimsByInstrument: new Map([["XAUUSD", new Set([strategyA, strategyB])]]),
            claimsByPositionKey: new Map([[positionKey, new Set([strategyB])]]),
            existingPositionByKey: new Map([
                [positionKey, {
                    strategyId: strategyA,
                }],
            ]),
            strategyMap,
        } as never)

        expect(resolved).toEqual({
            ownershipStatus: "orphaned",
        })
        expect(portfolioGovernanceTestables.hasPositionOwnershipMismatch({
            positionKey,
            claimsByPositionKey: new Map([[positionKey, new Set([strategyB])]]),
            existingPositionByKey: new Map([
                [positionKey, {
                    strategyId: strategyA,
                }],
            ]),
            strategyMap,
        } as never)).toBe(true)
    })

    it("builds adopted position claims from provider row keys and preserves unrelated claims", () => {
        const strategyA = "strategy-a"
        const strategyB = "strategy-b"

        const claims = portfolioGovernanceTestables.buildAdoptedPositionClaims({
            strategyId: strategyA,
            requestedInstruments: ["XAUUSD"],
            providerPositions: [
                {
                    instrument: "XAUUSD",
                    positionKey: "XAUUSD:1600791764",
                },
                {
                    instrument: "XAUUSD",
                    positionKey: "XAUUSD:1600791765",
                },
                {
                    instrument: "EURUSD",
                    positionKey: "EURUSD:long",
                },
            ],
            existingClaims: [
                {
                    strategyId: strategyA,
                    source: "position",
                    instrument: "EURUSD",
                    sourceId: "EURUSD:long",
                },
                {
                    strategyId: strategyB,
                    source: "position",
                    instrument: "XAUUSD",
                    sourceId: "XAUUSD:old",
                },
            ],
        } as never)

        expect(claims).toEqual([
            {
                instrument: "EURUSD",
                sourceId: "EURUSD:long",
            },
            {
                instrument: "XAUUSD",
                sourceId: "XAUUSD:1600791764",
            },
            {
                instrument: "XAUUSD",
                sourceId: "XAUUSD:1600791765",
            },
        ])
    })

    it("includes ownership mismatches in the drift summary", () => {
        expect(portfolioGovernanceTestables.createDriftSummary({
            unownedPositionCount: 0,
            unownedOrderCount: 0,
            closedPersistedOrders: [],
            statusMismatches: [],
            ownershipMismatches: ["XAUUSD:1600791764"],
        })).toBe("1 provider position ownership mismatch(es) were detected")
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

    it("matches expected external Polymarket rows by canonical market slug aliases", () => {
        const expectedExternal = portfolioGovernanceTestables.collectExpectedExternalInstruments([
            {
                _id: "strategy-manual",
                policy: {
                    safety: {
                        expectedExternalInstruments: ["will-the-us-acquire-any-part-of-greenland-in-2026"],
                    },
                },
            },
        ] as never)

        const flaggedAsExpectedExternal = portfolioGovernanceTestables.isExpectedExternalProviderRow(
            expectedExternal,
            {
                instrument: "token-active",
                metadata: JSON.stringify({
                    tokenId: "token-active",
                    marketSlug: "will-the-us-acquire-any-part-of-greenland-in-2026",
                    slug: "will-the-us-acquire-any-part-of-greenland-in-2026",
                }),
            }
        )

        expect(flaggedAsExpectedExternal).toBe(true)
    })
})
