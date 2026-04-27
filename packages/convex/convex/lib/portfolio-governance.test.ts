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
            untrackedOwnedOrderCount: 0,
            closedPersistedOrders: [],
            statusMismatches: [],
            ownershipMismatches: ["XAUUSD:1600791764"],
            exposureViolations: [],
        })).toBe("1 provider position ownership mismatch(es) were detected")
    })

    it("matches MT5 live working orders to the canonical tracked order across provider ticket changes", () => {
        const trackedOrder = {
            orderId: "1608821812",
            providerOrderId: "1608821812",
            providerOrderAliases: [],
            venue: "mt5",
            instrument: "XAUUSD",
            status: "pending",
            action: "entry",
            quantity: 0.01,
            filledQuantity: 0,
            remainingQuantity: 0.01,
            intent: {
                side: "sell",
                limitPrice: 4748,
                metadata: {
                    stopLoss: 4756.5,
                    takeProfit: 4729.3,
                },
            },
        }

        const matched = portfolioGovernanceTestables.resolveLiveWorkingOrderMatch({
            app: "mt5",
            liveOrder: {
                orderId: "1608821205",
                instrument: "XAUUSD",
                status: "pending",
                quantity: 0.01,
                filledQuantity: 0,
                remainingQuantity: 0.01,
                side: "sell",
                limitPrice: 4748,
                stopPrice: 4756.5,
                metadata: JSON.stringify({
                    takeProfit: 4729.3,
                }),
            },
            activeOrders: [trackedOrder],
            activeOrdersById: new Map([
                ["1608821812", trackedOrder],
            ]),
            matchedActiveOrderIds: new Set(),
        } as never)

        expect(matched).toBe(trackedOrder)
    })

    it("detects overlap violations from provider-truth positions and working orders", () => {
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [{
                _id: "strategy-a",
                policy: {
                    allowMultiplePendingEntryOrdersPerInstrument: false,
                    allowOverlappingExposure: false,
                },
            }],
            positions: [{
                strategyId: "strategy-a",
                ownershipStatus: "owned",
                instrument: "XAUUSD",
                side: "short",
            }],
            workingOrders: [{
                strategyId: "strategy-a",
                ownershipStatus: "owned",
                instrument: "XAUUSD",
                action: "entry",
                side: "sell",
            }],
        } as never)

        expect(violations).toEqual([
            "strategy-a:overlap:XAUUSD",
        ])
    })

    it("includes unmatched owned orders and exposure violations in the drift summary", () => {
        expect(portfolioGovernanceTestables.createDriftSummary({
            unownedPositionCount: 0,
            unownedOrderCount: 0,
            untrackedOwnedOrderCount: 1,
            closedPersistedOrders: [],
            statusMismatches: [],
            ownershipMismatches: [],
            exposureViolations: ["strategy-a:overlap:XAUUSD"],
        })).toBe(
            "1 owned live working order(s) were not matched to a canonical active order; 1 provider exposure governance violation(s) were detected"
        )
    })

    it("infers MT5 closed-order fill from provider ticket match and cancels stale unmatched rows", () => {
        const order = {
            orderId: "1600791764",
            providerOrderId: "1600791764",
            providerOrderAliases: [],
            action: "entry",
            quantity: 0.01,
            filledQuantity: 0,
            avgFillPrice: undefined,
            instrument: "XAUUSD",
            lastTransitionSequence: 0,
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

    it("infers non-MT5 entry fills from provider-truth live positions", () => {
        const order = {
            orderId: "order:BTC-USDT-SWAP:root",
            providerOrderId: "order:BTC-USDT-SWAP:live",
            providerOrderAliases: [],
            action: "entry",
            quantity: 0.2,
            filledQuantity: 0,
            avgFillPrice: undefined,
            instrument: "BTC-USDT-SWAP",
            lastTransitionSequence: 0,
            intent: {
                side: "sell",
            },
        }

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "okx-swap",
            order,
            livePositions: [
                {
                    instrument: "BTC-USDT-SWAP",
                    side: "short",
                    quantity: 0.2,
                    entryPrice: 101250,
                },
            ],
        } as never)

        expect(inferredFill).toEqual({
            status: "filled",
            filledQuantity: 0.2,
            remainingQuantity: 0,
            avgFillPrice: 101250,
        })
    })

    it("infers Alpaca vertical fills when provider truth groups the legs into an iron condor", () => {
        const order = {
            orderId: "alpaca-put-vertical",
            providerOrderId: "alpaca-put-vertical",
            providerOrderAliases: [],
            action: "entry",
            quantity: 1,
            filledQuantity: 0,
            avgFillPrice: undefined,
            instrument: "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000",
            lastTransitionSequence: 0,
            intent: {
                side: "sell",
                legs: [
                    { instrument: "SPY260501P00694000", side: "buy_to_open" },
                    { instrument: "SPY260501P00695000", side: "sell_to_open" },
                ],
            },
        }

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "alpaca-options",
            order,
            livePositions: [
                {
                    instrument: "IC:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000|SPY260501P00694000|SPY260501P00695000",
                    side: "short",
                    quantity: 1,
                    entryPrice: 0.44,
                },
            ],
        } as never)

        expect(inferredFill).toEqual({
            status: "filled",
            filledQuantity: 1,
            remainingQuantity: 0,
            avgFillPrice: 0.44,
        })
    })

    it("infers close fills when the targeted position is no longer live", () => {
        const order = {
            orderId: "provider-close:mt5:XAUUSD:123",
            providerOrderId: "1607000000",
            providerOrderAliases: [],
            action: "close",
            quantity: 1,
            filledQuantity: 0,
            avgFillPrice: 3335.2,
            instrument: "XAUUSD",
            lastTransitionSequence: 0,
            intent: {
                side: "sell",
                metadata: {
                    positionSide: "long",
                },
            },
        }

        const inferredClose = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "mt5",
            order,
            livePositions: [],
        } as never)

        expect(inferredClose).toEqual({
            status: "filled",
            filledQuantity: 1,
            remainingQuantity: 0,
            avgFillPrice: 3335.2,
        })
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
