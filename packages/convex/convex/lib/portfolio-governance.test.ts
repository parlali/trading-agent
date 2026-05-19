import { describe, expect, it } from "vitest"
import { getClaimInstrumentsForOrder } from "./instrumentClaims"
import { portfolioGovernanceTestables } from "./mutations/portfolio"

describe("portfolio governance helpers", () => {
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

    it("does not match MT5 live working orders by same-intent geometry after provider ticket changes", () => {
        const trackedOrder = {
            orderId: "1608821812",
            canonicalOrderId: "1608821812",
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

        expect(matched).toBeUndefined()
    })

    it("matches MT5 live working orders by canonical provider client id", () => {
        const trackedOrder = {
            orderId: "vmte01abcdef2345",
            canonicalOrderId: "vmte01abcdef2345",
            providerOrderId: "",
            providerClientOrderId: "vmte01abcdef2345",
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
                metadata: JSON.stringify({
                    providerClientOrderId: "vmte01abcdef2345",
                }),
            },
            activeOrders: [trackedOrder],
            activeOrdersById: new Map([
                ["vmte01abcdef2345", trackedOrder],
            ]),
            matchedActiveOrderIds: new Set(),
        } as never)

        expect(matched).toBe(trackedOrder)
    })

    it("detects overlap violations from provider-truth positions and working orders", () => {
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [{
                _id: "strategy-a",
                app: "mt5",
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

    it("detects Alpaca structure-order overlap against raw claimed provider legs", () => {
        const vertical = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [{
                _id: "strategy-a",
                app: "alpaca-options",
                policy: {
                    allowMultiplePendingEntryOrdersPerInstrument: false,
                    allowOverlappingExposure: false,
                },
            }],
            positions: [{
                strategyId: "strategy-a",
                ownershipStatus: "owned",
                instrument: "SPY260501P00695000",
                side: "short",
            }],
            workingOrders: [{
                strategyId: "strategy-a",
                ownershipStatus: "owned",
                instrument: vertical,
                action: "entry",
                side: "sell",
            }],
        } as never)

        expect(violations).toEqual([
            `strategy-a:overlap:${vertical}`,
        ])
    })

    it("detects duplicate Alpaca pending orders across equivalent structure aliases", () => {
        const vertical = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [{
                _id: "strategy-a",
                app: "alpaca-options",
                policy: {
                    allowMultiplePendingEntryOrdersPerInstrument: false,
                    allowOverlappingExposure: true,
                },
            }],
            positions: [],
            workingOrders: [
                {
                    strategyId: "strategy-a",
                    ownershipStatus: "owned",
                    instrument: vertical,
                    action: "entry",
                    side: "sell",
                },
                {
                    strategyId: "strategy-a",
                    ownershipStatus: "owned",
                    instrument: "SPY260501P00695000",
                    action: "entry",
                    side: "sell",
                },
            ],
        } as never)

        expect(violations).toEqual([
            `strategy-a:multiple-working-orders:${vertical}:sell`,
        ])
    })

    it("models OKX provider protection OCOs as canonical close working orders", () => {
        const intent = portfolioGovernanceTestables.buildProviderProtectionIntent(
            {
                instrument: "ETH-USDT-SWAP",
                side: "sell",
                quantity: 0.5,
                limitPrice: 3450,
                stopPrice: 3290,
            },
            {
                kind: "protection",
                orderType: "oco",
                tpTriggerPx: "3450",
                slTriggerPx: "3290",
            }
        )

        expect(intent).toMatchObject({
            instrument: "ETH-USDT-SWAP",
            side: "sell",
            quantity: 0.5,
            orderType: "stop_limit",
            limitPrice: 3450,
            stopPrice: 3290,
            timeInForce: "gtc",
            metadata: {
                action: "close",
                providerProtectionOrder: true,
                protectionOrderType: "oco",
                stopLoss: 3290,
                takeProfit: 3450,
            },
        })
    })

    it("imports OKX provider protection rows only when canonical client identity is present", () => {
        expect(portfolioGovernanceTestables.resolveCanonicalProviderProtectionOrderId({
            providerClientOrderId: "vokt01abcde23456",
            metadata: JSON.stringify({
                kind: "protection",
            }),
        })).toBe("vokt01abcde23456")

        expect(portfolioGovernanceTestables.resolveCanonicalProviderProtectionOrderId({
            providerClientOrderId: undefined,
            metadata: JSON.stringify({
                kind: "protection",
                algoId: "algo-1",
            }),
        })).toBeUndefined()

        expect(portfolioGovernanceTestables.resolveCanonicalProviderProtectionOrderId({
            providerClientOrderId: "algo-1",
            metadata: JSON.stringify({
                kind: "protection",
            }),
        })).toBeUndefined()
    })

    it("keeps duplicate-exposure faults blocked when provider truth matches more than one live order", () => {
        const fault = {
            category: "duplicate_exposure",
            instrument: "XAUUSD",
            canonicalOrderId: "vmtc01abcde23456",
            providerOrderId: undefined,
            providerClientOrderId: "vmtc01abcde23456",
            providerOrderAliases: ["1607003000"],
            signedOrderFingerprint: undefined,
        }
        const firstOrder = {
            orderId: "1607003000",
            providerOrderId: "1607003000",
            providerClientOrderId: "vmtc01abcde23456",
            providerOrderAliases: [],
            signedOrderFingerprint: undefined,
            instrument: "XAUUSD",
            ownershipStatus: "owned",
        }
        const secondOrder = {
            orderId: "1607003001",
            providerOrderId: "1607003001",
            providerClientOrderId: undefined,
            providerOrderAliases: ["vmtc01abcde23456"],
            signedOrderFingerprint: undefined,
            instrument: "XAUUSD",
            ownershipStatus: "owned",
        }

        expect(portfolioGovernanceTestables.resolveExecutionFaultWorkingOrder(
            fault as never,
            [firstOrder] as never
        )).toBe(firstOrder)
        expect(portfolioGovernanceTestables.resolveExecutionFaultWorkingOrder(
            fault as never,
            [firstOrder, secondOrder] as never
        )).toBeUndefined()
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

    it("infers MT5 market-order fills from canonical comments on live positions", () => {
        const order = {
            orderId: "vmte01filled1234",
            providerOrderId: undefined,
            providerClientOrderId: "vmte01filled1234",
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
                    entryPrice: 4715.75,
                    metadata: JSON.stringify({ ticket: 1607002000, comment: "vmte01filled1234" }),
                },
            ],
        } as never)

        expect(inferredFill.status).toBe("filled")
        expect(inferredFill.filledQuantity).toBe(0.01)
        expect(inferredFill.avgFillPrice).toBe(4715.75)
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

    it("does not infer Alpaca vertical fills from one matching raw provider leg", () => {
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
                    instrument: "SPY260501P00695000",
                    side: "short",
                    quantity: 1,
                    entryPrice: 0.44,
                },
            ],
        } as never)

        expect(inferredFill).toEqual({ status: "cancelled" })
    })

    it("infers Alpaca vertical fills only when every claimed leg is proven", () => {
        const order = createAlpacaVerticalOrder({ quantity: 2 })

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "alpaca-options",
            order,
            livePositions: [
                {
                    instrument: "SPY260501P00695000",
                    side: "short",
                    quantity: 2,
                    entryPrice: 0.44,
                },
                {
                    instrument: "SPY260501P00694000",
                    side: "long",
                    quantity: 2,
                    entryPrice: 0.19,
                },
            ],
        } as never)

        expect(inferredFill).toEqual({
            status: "filled",
            filledQuantity: 2,
            remainingQuantity: 0,
            avgFillPrice: 0.25,
        })
    })

    it("infers Alpaca partial fills only when all claimed legs have bounded residual quantity", () => {
        const order = createAlpacaVerticalOrder({ quantity: 3 })

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "alpaca-options",
            order,
            livePositions: [
                {
                    instrument: "SPY260501P00695000",
                    side: "short",
                    quantity: 1,
                    entryPrice: 0.44,
                },
                {
                    instrument: "SPY260501P00694000",
                    side: "long",
                    quantity: 1,
                    entryPrice: 0.19,
                },
            ],
        } as never)

        expect(inferredFill).toEqual({
            status: "partially_filled",
            filledQuantity: 1,
            remainingQuantity: 2,
            avgFillPrice: 0.25,
        })
    })

    it("rejects Alpaca entry-fill inference when a claimed leg has the wrong direction", () => {
        const order = createAlpacaVerticalOrder({ quantity: 1 })

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "alpaca-options",
            order,
            livePositions: [
                {
                    instrument: "SPY260501P00695000",
                    side: "long",
                    quantity: 1,
                    entryPrice: 0.44,
                },
                {
                    instrument: "SPY260501P00694000",
                    side: "long",
                    quantity: 1,
                    entryPrice: 0.19,
                },
            ],
        } as never)

        expect(inferredFill).toEqual({ status: "cancelled" })
    })

    it("infers true Alpaca four-leg IC fills from exact raw claimed legs", () => {
        const order = {
            orderId: "alpaca-ic",
            providerOrderId: "alpaca-ic",
            providerOrderAliases: [],
            action: "entry",
            quantity: 1,
            filledQuantity: 0,
            avgFillPrice: undefined,
            instrument: "IC:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000|SPY260501P00694000|SPY260501P00695000",
            lastTransitionSequence: 0,
            intent: {
                side: "sell",
                legs: [
                    { instrument: "SPY260501C00720000", side: "sell_to_open" },
                    { instrument: "SPY260501C00721000", side: "buy_to_open" },
                    { instrument: "SPY260501P00694000", side: "buy_to_open" },
                    { instrument: "SPY260501P00695000", side: "sell_to_open" },
                ],
            },
        }

        const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
            app: "alpaca-options",
            order,
            livePositions: [
                { instrument: "SPY260501C00720000", side: "short", quantity: 1, entryPrice: 0.3 },
                { instrument: "SPY260501C00721000", side: "long", quantity: 1, entryPrice: 0.12 },
                { instrument: "SPY260501P00694000", side: "long", quantity: 1, entryPrice: 0.19 },
                { instrument: "SPY260501P00695000", side: "short", quantity: 1, entryPrice: 0.44 },
            ],
        } as never)

        expect(inferredFill).toEqual({
            status: "filled",
            filledQuantity: 1,
            remainingQuantity: 0,
            avgFillPrice: 0.43,
        })
    })

    it("keeps separate SPY call and put vertical claims from becoming an owned synthetic IC", () => {
        const callStrategy = "strategy-call"
        const putStrategy = "strategy-put"
        const callVertical = "VS:BEAR_CALL_CREDIT:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000"
        const putVertical = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"
        const syntheticIronCondor = "IC:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000|SPY260501P00694000|SPY260501P00695000"
        const claimsByInstrument = buildClaimsByInstrument([
            {
                strategyId: callStrategy,
                instruments: getClaimInstrumentsForOrder(callVertical, {
                    legs: [
                        { instrument: "SPY260501C00720000", side: "sell_to_open" },
                        { instrument: "SPY260501C00721000", side: "buy_to_open" },
                    ],
                }),
            },
            {
                strategyId: putStrategy,
                instruments: getClaimInstrumentsForOrder(putVertical, {
                    legs: [
                        { instrument: "SPY260501P00694000", side: "buy_to_open" },
                        { instrument: "SPY260501P00695000", side: "sell_to_open" },
                    ],
                }),
            },
        ])
        const strategyMap = new Map([
            [callStrategy, { _id: callStrategy }],
            [putStrategy, { _id: putStrategy }],
        ])

        expect(portfolioGovernanceTestables.resolveOwnership({
            app: "alpaca-options",
            instrument: "SPY260501C00720000",
            claimsByInstrument,
            strategyMap,
        } as never)).toEqual({
            strategyId: callStrategy,
            ownershipStatus: "owned",
        })
        expect(portfolioGovernanceTestables.resolveOwnership({
            app: "alpaca-options",
            instrument: "SPY260501P00695000",
            claimsByInstrument,
            strategyMap,
        } as never)).toEqual({
            strategyId: putStrategy,
            ownershipStatus: "owned",
        })
        expect(portfolioGovernanceTestables.resolveOwnership({
            app: "alpaca-options",
            instrument: syntheticIronCondor,
            claimsByInstrument,
            strategyMap,
        } as never)).toEqual({
            ownershipStatus: "orphaned",
        })
    })

    it("keeps a true four-leg Alpaca IC claim owned as one structure", () => {
        const strategyId = "strategy-ic"
        const ironCondor = "IC:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000|SPY260501P00694000|SPY260501P00695000"
        const claimsByInstrument = buildClaimsByInstrument([
            {
                strategyId,
                instruments: getClaimInstrumentsForOrder(ironCondor, {
                    legs: [
                        { instrument: "SPY260501C00720000", side: "sell_to_open" },
                        { instrument: "SPY260501C00721000", side: "buy_to_open" },
                        { instrument: "SPY260501P00694000", side: "buy_to_open" },
                        { instrument: "SPY260501P00695000", side: "sell_to_open" },
                    ],
                }),
            },
        ])
        const strategyMap = new Map([[strategyId, { _id: strategyId }]])

        for (const instrument of [
            ironCondor,
            "SPY260501C00720000",
            "SPY260501C00721000",
            "SPY260501P00694000",
            "SPY260501P00695000",
        ]) {
            expect(portfolioGovernanceTestables.resolveOwnership({
                app: "alpaca-options",
                instrument,
                claimsByInstrument,
                strategyMap,
            } as never)).toEqual({
                strategyId,
                ownershipStatus: "owned",
            })
        }
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

function buildClaimsByInstrument(entries: Array<{
    strategyId: string
    instruments: string[]
}>): Map<string, Set<string>> {
    const claims = new Map<string, Set<string>>()

    for (const entry of entries) {
        for (const instrument of entry.instruments) {
            const strategies = claims.get(instrument) ?? new Set<string>()
            strategies.add(entry.strategyId)
            claims.set(instrument, strategies)
        }
    }

    return claims
}

function createAlpacaVerticalOrder(args: {
    quantity: number
}) {
    return {
        orderId: "alpaca-put-vertical",
        providerOrderId: "alpaca-put-vertical",
        providerOrderAliases: [],
        action: "entry",
        quantity: args.quantity,
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
}
