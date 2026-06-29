import { describe, expect, it } from "vitest"
import { getClaimInstrumentsForOrder } from "../../convex/lib/instrumentClaims"
import { portfolioGovernanceTestables } from "../../convex/lib/mutations/portfolio"

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

    it("fails closed for same-account same-instrument claims across strategies", () => {
        const strategyA = "strategy-a"
        const strategyB = "strategy-b"
        const strategyMap = new Map([
            [strategyA, { _id: strategyA }],
            [strategyB, { _id: strategyB }],
        ])
        const claimsByInstrument = new Map([
            ["XAUUSD", new Set([strategyA, strategyB])],
        ])

        const resolvedA = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey: "XAUUSD:1600791764",
            claimsByInstrument,
            strategyMap,
        } as never)
        const resolvedB = portfolioGovernanceTestables.resolveOwnership({
            instrument: "XAUUSD",
            positionKey: "XAUUSD:1600791765",
            claimsByInstrument,
            strategyMap,
        } as never)

        expect(resolvedA).toEqual({
            ownershipStatus: "orphaned",
        })
        expect(resolvedB).toEqual({
            ownershipStatus: "orphaned",
        })
    })

    it("fails closed when a provider row owner conflicts with an instrument claim", () => {
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
            claimsByInstrument: new Map([["XAUUSD", new Set([strategyB])]]),
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
            existingPositionByKey: new Map([
                [positionKey, {
                    strategyId: strategyA,
                }],
            ]),
            strategyMap,
            resolvedOwnership: resolved,
        } as never)).toBe(true)
    })

    it("flags same-account instrument ownership across strategies as duplicate exposure", () => {
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [
                {
                    _id: "strategy-a",
                    app: "okx-swap",
                    accountId: "account-a",
                    policy: {},
                },
                {
                    _id: "strategy-b",
                    app: "okx-swap",
                    accountId: "account-a",
                    policy: {},
                },
            ],
            positions: [
                {
                    strategyId: "strategy-a",
                    ownershipStatus: "owned",
                    instrument: "BTC-USDT-SWAP",
                    side: "long",
                },
                {
                    strategyId: "strategy-b",
                    ownershipStatus: "owned",
                    instrument: "BTC-USDT-SWAP",
                    side: "long",
                },
            ],
            workingOrders: [],
        } as never)

        expect(violations).toEqual([
            "strategy-a:account-instrument-conflict:BTC-USDT-SWAP",
            "strategy-b:account-instrument-conflict:BTC-USDT-SWAP",
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

    it("only repairs zero-fill terminal working orders when provider truth shows them live", () => {
        expect(portfolioGovernanceTestables.isRepairableTerminalWorkingOrder({
            status: "cancelled",
            filledQuantity: 0,
        } as never)).toBe(true)
        expect(portfolioGovernanceTestables.isRepairableTerminalWorkingOrder({
            status: "timed_out",
            filledQuantity: 0,
        } as never)).toBe(true)
        expect(portfolioGovernanceTestables.isRepairableTerminalWorkingOrder({
            status: "cancelled",
            filledQuantity: 0.01,
        } as never)).toBe(false)
        expect(portfolioGovernanceTestables.isRepairableTerminalWorkingOrder({
            status: "filled",
            filledQuantity: 0.01,
        } as never)).toBe(false)
        expect(portfolioGovernanceTestables.isRepairableTerminalWorkingOrder({
            status: "pending",
            filledQuantity: 0,
        } as never)).toBe(false)
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

    it("rejects Alpaca structure entry-fill inference without complete claimed-leg proof", () => {
        const cases = [
            {
                name: "one raw leg only",
                order: createAlpacaVerticalOrder({ quantity: 1 }),
                livePositions: [
                    {
                        instrument: "SPY260501P00695000",
                        side: "short",
                        quantity: 1,
                        entryPrice: 0.44,
                    },
                ],
            },
            {
                name: "wrong claimed-leg direction",
                order: createAlpacaVerticalOrder({ quantity: 1 }),
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
            },
        ]

        for (const testCase of cases) {
            const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
                app: "alpaca-options",
                order: testCase.order,
                livePositions: testCase.livePositions,
            } as never)

            expect(inferredFill, testCase.name).toEqual({ status: "cancelled" })
        }
    })

    it("infers Alpaca structure entry fills from complete raw claimed-leg proof", () => {
        const cases = [
            {
                name: "vertical full fill",
                order: createAlpacaVerticalOrder({ quantity: 2 }),
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
                expected: {
                    status: "filled",
                    filledQuantity: 2,
                    remainingQuantity: 0,
                    avgFillPrice: 0.25,
                },
            },
            {
                name: "vertical partial fill",
                order: createAlpacaVerticalOrder({ quantity: 3 }),
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
                expected: {
                    status: "partially_filled",
                    filledQuantity: 1,
                    remainingQuantity: 2,
                    avgFillPrice: 0.25,
                },
            },
            {
                name: "iron condor full fill",
                order: createAlpacaIronCondorOrder(),
                livePositions: [
                    { instrument: "SPY260501C00720000", side: "short", quantity: 1, entryPrice: 0.3 },
                    { instrument: "SPY260501C00721000", side: "long", quantity: 1, entryPrice: 0.12 },
                    { instrument: "SPY260501P00694000", side: "long", quantity: 1, entryPrice: 0.19 },
                    { instrument: "SPY260501P00695000", side: "short", quantity: 1, entryPrice: 0.44 },
                ],
                expected: {
                    status: "filled",
                    filledQuantity: 1,
                    remainingQuantity: 0,
                    avgFillPrice: 0.43,
                },
            },
        ]

        for (const testCase of cases) {
            const inferredFill = portfolioGovernanceTestables.inferClosedOrderStatus({
                app: "alpaca-options",
                order: testCase.order,
                livePositions: testCase.livePositions,
            } as never)

            expect(inferredFill, testCase.name).toEqual(testCase.expected)
        }
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
                        expectedExternalInstruments: ["synthetic-external-market-2026"],
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
                    marketSlug: "synthetic-external-market-2026",
                    slug: "synthetic-external-market-2026",
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

function createAlpacaIronCondorOrder() {
    return {
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
}

describe("polymarket duplicate exposure governance", () => {
    const conditionId = "0xcond1"

    it("collides YES and NO outcome tokens of one market across strategies on the same account", () => {
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [
                {
                    _id: "strategy-yes",
                    app: "polymarket",
                    accountId: "account-1",
                    policy: {},
                },
                {
                    _id: "strategy-no",
                    app: "polymarket",
                    accountId: "account-1",
                    policy: {},
                },
            ],
            positions: [
                {
                    strategyId: "strategy-yes",
                    ownershipStatus: "owned",
                    instrument: "token-yes",
                    side: "long",
                    metadata: JSON.stringify({
                        tokenId: "token-yes",
                        conditionId,
                        outcome: "Yes",
                    }),
                },
                {
                    strategyId: "strategy-no",
                    ownershipStatus: "owned",
                    instrument: "token-no",
                    side: "long",
                    metadata: JSON.stringify({
                        tokenId: "token-no",
                        conditionId,
                        outcome: "No",
                    }),
                },
            ],
            workingOrders: [],
        } as never)

        expect(violations).toEqual([
            "strategy-no:account-instrument-conflict:token-no",
            "strategy-yes:account-instrument-conflict:token-yes",
        ])
    })

    it("collides a pending NO entry order against a held YES position of the same market", () => {
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [
                {
                    _id: "strategy-yes",
                    app: "polymarket",
                    accountId: "account-1",
                    policy: {},
                },
                {
                    _id: "strategy-no",
                    app: "polymarket",
                    accountId: "account-1",
                    policy: {},
                },
            ],
            positions: [
                {
                    strategyId: "strategy-yes",
                    ownershipStatus: "owned",
                    instrument: "token-yes",
                    side: "long",
                    metadata: JSON.stringify({
                        tokenId: "token-yes",
                        conditionId,
                    }),
                },
            ],
            workingOrders: [
                {
                    strategyId: "strategy-no",
                    ownershipStatus: "owned",
                    instrument: "token-no",
                    action: "entry",
                    side: "buy",
                    metadata: JSON.stringify({
                        tokenId: "token-no",
                        conditionId,
                    }),
                },
            ],
        } as never)

        expect(violations).toEqual([
            "strategy-no:account-instrument-conflict:token-no",
            "strategy-yes:account-instrument-conflict:token-yes",
        ])
    })

    it("does not collide outcome tokens of different markets", () => {
        const violations = portfolioGovernanceTestables.detectExposureGovernanceViolations({
            strategies: [
                {
                    _id: "strategy-yes",
                    app: "polymarket",
                    accountId: "account-1",
                    policy: {},
                },
                {
                    _id: "strategy-other",
                    app: "polymarket",
                    accountId: "account-1",
                    policy: {},
                },
            ],
            positions: [
                {
                    strategyId: "strategy-yes",
                    ownershipStatus: "owned",
                    instrument: "token-yes",
                    side: "long",
                    metadata: JSON.stringify({
                        tokenId: "token-yes",
                        conditionId,
                    }),
                },
                {
                    strategyId: "strategy-other",
                    ownershipStatus: "owned",
                    instrument: "token-other",
                    side: "long",
                    metadata: JSON.stringify({
                        tokenId: "token-other",
                        conditionId: "0xcond2",
                    }),
                },
            ],
            workingOrders: [],
        } as never)

        expect(violations).toEqual([])
    })
})
