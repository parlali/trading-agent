import { describe, expect, it } from "vitest"
import { validateIntent, type OrderIntent, type Position, type AccountState } from "@valiq-trading/core"
import { alpacaRiskValidators, buildCreditVerticalInstrumentFromLegs } from "./risk-rules"

const structureValidator = alpacaRiskValidators[0]!

const accountState: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const positions: Position[] = []

const maxLossPolicy = {
    llm: {
        provider: "codex",
        model: "gpt-5.5",
        authMode: "chatgpt",
    },
    maxLossPerPlay: 150,
}

function validate(intent: OrderIntent) {
    return structureValidator(intent, {}, accountState, positions)
}

function validateRisk(intent: OrderIntent, policy: Record<string, unknown>) {
    return validateIntent(intent, policy, accountState, positions, alpacaRiskValidators)
}

function validateRiskWithState(
    intent: OrderIntent,
    policy: Record<string, unknown>,
    state: AccountState,
    ownedPositions: Position[]
) {
    return validateIntent(intent, policy, state, ownedPositions, alpacaRiskValidators)
}

function createAccountState(equity: number): AccountState {
    return {
        balance: equity,
        equity,
        buyingPower: equity,
        marginUsed: 0,
        marginAvailable: equity,
        openPnl: 0,
        dayPnl: 0,
    }
}

describe("alpaca structure validator", () => {
    it("accepts Alpaca credit entry structures and canonicalizes their instruments", () => {
        const cases = [
            {
                intent: {
                    instrument: "SPY",
                    side: "sell" as const,
                    quantity: 1,
                    orderType: "limit" as const,
                    limitPrice: 1.2,
                    timeInForce: "day" as const,
                    legs: [
                        {
                            instrument: "SPY260417C00550000",
                            side: "sell_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417C00555000",
                            side: "buy_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417P00500000",
                            side: "sell_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417P00495000",
                            side: "buy_to_open" as const,
                            quantity: 1,
                        },
                    ],
                },
                instrumentPrefix: "IC:SPY:2026-04-17:",
                metadata: {
                    structureType: "iron_condor",
                    underlying: "SPY",
                    expiration: "2026-04-17",
                },
            },
            {
                intent: {
                    instrument: "SPY",
                    side: "sell" as const,
                    quantity: 1,
                    orderType: "limit" as const,
                    limitPrice: 0.85,
                    timeInForce: "day" as const,
                    legs: [
                        {
                            instrument: "SPY260417P00500000",
                            side: "sell_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417P00495000",
                            side: "buy_to_open" as const,
                            quantity: 1,
                        },
                    ],
                },
                instrumentPrefix: "VS:BULL_PUT_CREDIT:SPY:2026-04-17:",
                metadata: {
                    structureType: "credit_vertical",
                    verticalSpreadType: "bull_put_credit",
                    underlying: "SPY",
                    expiration: "2026-04-17",
                },
            },
        ]

        for (const testCase of cases) {
            const result = validate(testCase.intent)

            expect(result.allowed).toBe(true)
            expect(result.adjustedIntent?.instrument.startsWith(testCase.instrumentPrefix)).toBe(true)
            expect(result.adjustedIntent?.metadata).toMatchObject(testCase.metadata)
        }
    })

    it("enforces opt-in minimum credit floors for Alpaca credit entries", () => {
        const policy = {
            ...maxLossPolicy,
            minCreditToWidthPercent: 18,
        }
        const lowCredit = validateRisk(createIwmBullPutIntent(0.09), policy)

        expect(lowCredit.allowed).toBe(false)
        expect(lowCredit.reason).toContain("credit-to-width 9%")
        expect(lowCredit.reason).toContain("floor 18%")

        const enoughCredit = validateRisk(createIwmBullPutIntent(0.28), policy)
        expect(enoughCredit.allowed).toBe(true)

        const gateDisabled = validateRisk(createIwmBullPutIntent(0.09), maxLossPolicy)
        expect(gateDisabled.allowed).toBe(true)

        const wideLiveSpread = validateRisk(createIwmBullPutIntent(0.28, {
            legQuotes: [
                {
                    symbol: "IWM260717P00284000",
                    bid: 0.35,
                    ask: 0.45,
                },
                {
                    symbol: "IWM260717P00283000",
                    bid: 0.06,
                    ask: 0.16,
                },
            ],
        }), {
            ...maxLossPolicy,
            minCreditToSpreadRatio: 1.5,
        })

        expect(wideLiveSpread.allowed).toBe(false)
        expect(wideLiveSpread.reason).toContain("credit-to-spread 1.4x")
        expect(wideLiveSpread.reason).toContain("floor 1.5x")
    })

    it("rejects Alpaca credit entries below the per-contract credit floor", () => {
        const policy = {
            ...maxLossPolicy,
            minCreditPerContract: 0.2,
        }

        const pennyCredit = validateRisk(createIwmBullPutIntent(0.15), policy)
        expect(pennyCredit.allowed).toBe(false)
        expect(pennyCredit.reason).toContain("credit per contract $0.15")
        expect(pennyCredit.reason).toContain("floor $0.2")

        const payingCredit = validateRisk(createIwmBullPutIntent(0.25), policy)
        expect(payingCredit.allowed).toBe(true)

        const gateDisabled = validateRisk(createIwmBullPutIntent(0.15), maxLossPolicy)
        expect(gateDisabled.allowed).toBe(true)

        const cheapClose = validateRisk(
            { ...createNvdaBearCallCloseIntent(), limitPrice: 0.05 },
            policy
        )
        expect(cheapClose.allowed).toBe(true)
    })

    it("accepts 2-leg credit vertical closes and normalizes top-level side to buy", () => {
        const result = validate({
            instrument: "SPY",
            side: "buy",
            quantity: 1,
            orderType: "limit",
            limitPrice: 0.35,
            timeInForce: "day",
            metadata: {
                action: "close",
            },
            legs: [
                {
                    instrument: "SPY260417C00550000",
                    side: "buy_to_close",
                    quantity: 1,
                },
                {
                    instrument: "SPY260417C00555000",
                    side: "sell_to_close",
                    quantity: 1,
                },
            ],
        })

        expect(result.allowed).toBe(true)
        expect(result.adjustedIntent?.side).toBe("buy")
        expect(result.adjustedIntent?.metadata).toMatchObject({
            action: "close",
            structureType: "credit_vertical",
            verticalSpreadType: "bear_call_credit",
        })
    })

    it("nets the credit received when enforcing max loss per play", () => {
        const maxLossValidator = alpacaRiskValidators[3]!
        const nvdaWideStrikesIntent: OrderIntent = {
            instrument: "NVDA",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 1.1,
            timeInForce: "day",
            legs: [
                {
                    instrument: "NVDA260717C00212500",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "NVDA260717C00215000",
                    side: "buy_to_open",
                    quantity: 1,
                },
                {
                    instrument: "NVDA260717P00205000",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "NVDA260717P00202500",
                    side: "buy_to_open",
                    quantity: 1,
                },
            ],
        }

        const allowed = maxLossValidator(
            nvdaWideStrikesIntent,
            maxLossPolicy,
            accountState,
            positions
        )
        expect(allowed.allowed).toBe(true)

        const thinCredit = maxLossValidator(
            { ...nvdaWideStrikesIntent, limitPrice: 0.5 },
            maxLossPolicy,
            accountState,
            positions
        )
        expect(thinCredit.allowed).toBe(false)
        expect(thinCredit.reason).toContain("max loss 200")
    })

    it("never blocks closes on max loss per play", () => {
        const maxLossValidator = alpacaRiskValidators[3]!
        const result = maxLossValidator(
            {
                instrument: "NVDA",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 0.4,
                timeInForce: "day",
                metadata: {
                    action: "close",
                },
                legs: [
                    {
                        instrument: "NVDA260717C00212500",
                        side: "buy_to_close",
                        quantity: 1,
                    },
                    {
                        instrument: "NVDA260717C00215000",
                        side: "sell_to_close",
                        quantity: 1,
                    },
                ],
            },
            maxLossPolicy,
            accountState,
            positions
        )

        expect(result.allowed).toBe(true)
    })

    it("rejects a replayed same-thesis stack before the aggregate cap", () => {
        const result = validateRiskWithState(
            createNvdaBearCallIntent({
                limitPrice: 0.63,
            }),
            {
                ...maxLossPolicy,
                maxLossPerPlay: 250,
                maxAggregateRiskPercent: 3,
                maxSameThesisEntries: 2,
            },
            createAccountState(50_000),
            createOwnedBearCallLegPositions({
                quantity: 8,
                netCredit: 0.63,
            })
        )

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("Same Alpaca options thesis")
        expect(result.reason).toContain("limit 2")
        expect(result.reason).toContain("owned 8")
    })

    it("rejects aggregate risk above policy and allows the same entry below it", () => {
        const policy = {
            ...maxLossPolicy,
            maxLossPerPlay: 250,
            maxAggregateRiskPercent: 3,
        }
        const entry = createNvdaBearCallIntent({
            shortStrike: 220,
            longStrike: 221,
            limitPrice: 0.7,
        })
        const rejected = validateRiskWithState(entry, policy, accountState, [
            createOwnedBearCallPosition({
                shortStrike: 200,
                longStrike: 203,
                credit: 0.2,
            }),
        ])

        expect(rejected.allowed).toBe(false)
        expect(rejected.reason).toContain("Aggregate Alpaca options max loss")
        expect(rejected.reason).toContain("3.1%")

        const allowed = validateRiskWithState(entry, policy, accountState, [
            createOwnedBearCallPosition({
                shortStrike: 200,
                longStrike: 203,
                credit: 0.4,
            }),
        ])

        expect(allowed.allowed).toBe(true)
    })

    it("never blocks closes when aggregate and same-thesis caps are already breached", () => {
        const result = validateRiskWithState(
            createNvdaBearCallCloseIntent(),
            {
                ...maxLossPolicy,
                maxLossPerPlay: 250,
                maxAggregateRiskPercent: 3,
                maxSameThesisEntries: 2,
            },
            createAccountState(50_000),
            [
                createOwnedBearCallPosition({
                    quantity: 9,
                    credit: 0.63,
                }),
            ]
        )

        expect(result.allowed).toBe(true)
    })

    it("leaves aggregate and same-thesis validators disabled when policy fields are absent", () => {
        const result = validateRiskWithState(
            createNvdaBearCallIntent({
                limitPrice: 0.63,
            }),
            {
                ...maxLossPolicy,
                maxLossPerPlay: 250,
            },
            createAccountState(50_000),
            [
                createOwnedBearCallPosition({
                    quantity: 9,
                    credit: 0.63,
                }),
            ]
        )

        expect(result.allowed).toBe(true)
    })

    it("rejects non-2/4-leg structures", () => {
        const result = validate({
            instrument: "SPY",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 0.45,
            timeInForce: "day",
            legs: [
                {
                    instrument: "SPY260417P00500000",
                    side: "sell_to_open",
                    quantity: 1,
                },
            ],
        })

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("2 or 4")
    })
})

describe("alpaca owned-structure thesis resolution", () => {
    const thesisPolicy = {
        ...maxLossPolicy,
        maxLossPerPlay: 250,
        maxSameThesisEntries: 2,
    }

    it("accepts an entry while the book owns a legacy structure without thesis metadata", () => {
        const result = validateRiskWithState(
            createNvdaBearCallIntent({
                limitPrice: 0.63,
            }),
            thesisPolicy,
            createAccountState(50_000),
            [createLegacyOwnedStructurePosition()]
        )

        expect(result.allowed).toBe(true)
    })

    it("accepts an entry while the book owns unclaimed provider legs of another thesis", () => {
        const result = validateRiskWithState(
            createNvdaBearCallIntent({
                limitPrice: 0.63,
            }),
            thesisPolicy,
            createAccountState(50_000),
            createOwnedBearCallLegPositions({
                quantity: 8,
                netCredit: 0.63,
                shortStrike: 195,
                longStrike: 197.5,
                claimed: false,
            })
        )

        expect(result.allowed).toBe(true)
    })

    it("still rejects same-thesis stacking built from unclaimed provider legs", () => {
        const result = validateRiskWithState(
            createNvdaBearCallIntent({
                limitPrice: 0.63,
            }),
            thesisPolicy,
            createAccountState(50_000),
            createOwnedBearCallLegPositions({
                quantity: 8,
                netCredit: 0.63,
                claimed: false,
            })
        )

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("Same Alpaca options thesis")
        expect(result.reason).toContain("owned 8")
    })

    it("rejects an entry that cannot state its own thesis even when owned structures are legacy", () => {
        const thesisValidator = alpacaRiskValidators[4]!
        const result = thesisValidator(
            {
                instrument: "NVDA",
                side: "sell",
                quantity: 1,
                orderType: "limit",
                limitPrice: 0.63,
                timeInForce: "day",
                legs: [
                    {
                        instrument: "NVDA-BEAR-CALL-SPREAD",
                        side: "sell_to_open",
                        quantity: 1,
                    },
                    {
                        instrument: "NVDA-BEAR-CALL-HEDGE",
                        side: "buy_to_open",
                        quantity: 1,
                    },
                ],
            },
            thesisPolicy,
            createAccountState(50_000),
            [createLegacyOwnedStructurePosition()]
        )

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("Unable to determine Alpaca entry structure thesis")
    })

    it("counts legacy structure max loss in the aggregate cap and fails closed on unmeasurable legs", () => {
        const entry = createNvdaBearCallIntent({
            limitPrice: 0.63,
        })
        const legacyPosition = createLegacyOwnedStructurePosition()

        const rejected = validateRiskWithState(
            entry,
            {
                ...thesisPolicy,
                maxAggregateRiskPercent: 0.5,
            },
            createAccountState(50_000),
            [legacyPosition]
        )

        expect(rejected.allowed).toBe(false)
        expect(rejected.reason).toContain("Aggregate Alpaca options max loss")
        expect(rejected.reason).toContain("owned $200, entry $187")

        const allowed = validateRiskWithState(
            entry,
            {
                ...thesisPolicy,
                maxAggregateRiskPercent: 1,
            },
            createAccountState(50_000),
            [legacyPosition]
        )

        expect(allowed.allowed).toBe(true)

        const nakedLeg = createOwnedBearCallLegPositions({
            quantity: 1,
            netCredit: 0.63,
            claimed: false,
        })[0]!
        const unmeasurable = validateRiskWithState(
            entry,
            {
                ...thesisPolicy,
                maxAggregateRiskPercent: 5,
            },
            createAccountState(50_000),
            [nakedLeg]
        )

        expect(unmeasurable.allowed).toBe(false)
        expect(unmeasurable.reason).toContain("Unable to evaluate owned Alpaca option max loss")
    })
})

describe("alpaca short-strike delta ceiling", () => {
    const deltaCeilingPolicy = {
        ...maxLossPolicy,
        shortStrikeDeltaCeiling: 0.2,
    }

    it("rejects credit verticals whose short strike sits beyond the delta ceiling", () => {
        const tooDirectional = validateRisk(
            createIwmBullPutIntent(0.28, { shortStrikeDelta: -0.3 }),
            deltaCeilingPolicy
        )

        expect(tooDirectional.allowed).toBe(false)
        expect(tooDirectional.reason).toContain("short-strike delta 0.3")
        expect(tooDirectional.reason).toContain("ceiling 0.2")

        const withinCeiling = validateRisk(
            createIwmBullPutIntent(0.28, { shortStrikeDelta: -0.15 }),
            deltaCeilingPolicy
        )

        expect(withinCeiling.allowed).toBe(true)
    })

    it("rejects iron condors when either short side breaches the delta ceiling", () => {
        const breachedCallSide = validateRisk(
            createSpyIronCondorIntent({ shortCallDelta: 0.25, shortPutDelta: 0.15 }),
            deltaCeilingPolicy
        )

        expect(breachedCallSide.allowed).toBe(false)
        expect(breachedCallSide.reason).toContain("short-strike delta 0.25")
        expect(breachedCallSide.reason).toContain("shortCallDelta")

        const bothSidesWithinCeiling = validateRisk(
            createSpyIronCondorIntent({ shortCallDelta: 0.15, shortPutDelta: -0.15 }),
            deltaCeilingPolicy
        )

        expect(bothSidesWithinCeiling.allowed).toBe(true)
    })

    it("rejects ceiling-bearing entries that omit the short-strike delta", () => {
        const missingDelta = validateRisk(createIwmBullPutIntent(0.28), deltaCeilingPolicy)

        expect(missingDelta.allowed).toBe(false)
        expect(missingDelta.reason).toContain("supply shortStrikeDelta")
        expect(missingDelta.reason).toContain("IWM260717P00284000")

        const missingCondorSide = validateRisk(
            createSpyIronCondorIntent({ shortCallDelta: 0.15 }),
            deltaCeilingPolicy
        )

        expect(missingCondorSide.allowed).toBe(false)
        expect(missingCondorSide.reason).toContain("supply shortPutDelta")
    })

    it("keeps the legacy credit-to-width floor working without demanding a delta", () => {
        const legacyPolicy = {
            ...maxLossPolicy,
            minCreditToWidthPercent: 18,
        }

        const belowFloor = validateRisk(createIwmBullPutIntent(0.09), legacyPolicy)

        expect(belowFloor.allowed).toBe(false)
        expect(belowFloor.reason).toContain("credit-to-width 9%")

        const aboveFloor = validateRisk(createIwmBullPutIntent(0.28), legacyPolicy)

        expect(aboveFloor.allowed).toBe(true)
    })
})

function createSpyIronCondorIntent(
    metadata?: Record<string, unknown>
): OrderIntent {
    return {
        instrument: "SPY",
        side: "sell",
        quantity: 1,
        orderType: "limit",
        limitPrice: 0.6,
        timeInForce: "day",
        metadata,
        legs: [
            {
                instrument: "SPY260417C00550000",
                side: "sell_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260417C00551000",
                side: "buy_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260417P00500000",
                side: "sell_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260417P00499000",
                side: "buy_to_open",
                quantity: 1,
            },
        ],
    }
}

function createIwmBullPutIntent(
    limitPrice: number,
    metadata?: Record<string, unknown>
): OrderIntent {
    return {
        instrument: "IWM",
        side: "sell",
        quantity: 1,
        orderType: "limit",
        limitPrice,
        timeInForce: "day",
        metadata,
        legs: [
            {
                instrument: "IWM260717P00284000",
                side: "sell_to_open",
                quantity: 1,
            },
            {
                instrument: "IWM260717P00283000",
                side: "buy_to_open",
                quantity: 1,
            },
        ],
    }
}

function createNvdaBearCallIntent(args: {
    shortStrike?: number
    longStrike?: number
    limitPrice: number
}): OrderIntent {
    const legs = createBearCallLegs({
        underlying: "NVDA",
        expiration: "2026-07-31",
        shortStrike: args.shortStrike ?? 202.5,
        longStrike: args.longStrike ?? 205,
        action: "entry",
    })

    return {
        instrument: "NVDA",
        side: "sell",
        quantity: 1,
        orderType: "limit",
        limitPrice: args.limitPrice,
        timeInForce: "day",
        legs,
    }
}

function createNvdaBearCallCloseIntent(): OrderIntent {
    return {
        instrument: "NVDA",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 0.4,
        timeInForce: "day",
        metadata: {
            action: "close",
        },
        legs: createBearCallLegs({
            underlying: "NVDA",
            expiration: "2026-07-31",
            shortStrike: 202.5,
            longStrike: 205,
            action: "close",
        }),
    }
}

function createOwnedBearCallPosition(args: {
    shortStrike?: number
    longStrike?: number
    credit: number
    quantity?: number
}): Position {
    const legs = createBearCallLegs({
        underlying: "NVDA",
        expiration: "2026-07-31",
        shortStrike: args.shortStrike ?? 202.5,
        longStrike: args.longStrike ?? 205,
        action: "entry",
    })
    const instrument = buildCreditVerticalInstrumentFromLegs(
        "NVDA",
        "2026-07-31",
        "bear_call_credit",
        legs
    )

    return {
        instrument,
        side: "short",
        quantity: args.quantity ?? 1,
        entryPrice: args.credit,
    }
}

function createOwnedBearCallLegPositions(args: {
    quantity: number
    netCredit: number
    shortStrike?: number
    longStrike?: number
    claimed?: boolean
}): Position[] {
    const legs = createBearCallLegs({
        underlying: "NVDA",
        expiration: "2026-07-31",
        shortStrike: args.shortStrike ?? 202.5,
        longStrike: args.longStrike ?? 205,
        action: "entry",
    })
    const claimInstrument = buildCreditVerticalInstrumentFromLegs(
        "NVDA",
        "2026-07-31",
        "bear_call_credit",
        legs
    )
    const metadata = args.claimed === false
        ? undefined
        : {
            alpacaClaimInstrument: claimInstrument,
        }
    const shortLeg = legs[0]!
    const longLeg = legs[1]!
    const longEntryPrice = 0.17
    const shortEntryPrice = args.netCredit + longEntryPrice

    return [
        {
            instrument: shortLeg.instrument,
            providerPositionId: `${shortLeg.instrument}:short`,
            side: "short",
            quantity: args.quantity,
            entryPrice: shortEntryPrice,
            metadata,
        },
        {
            instrument: longLeg.instrument,
            providerPositionId: `${longLeg.instrument}:long`,
            side: "long",
            quantity: args.quantity,
            entryPrice: longEntryPrice,
            metadata,
        },
    ]
}

function createLegacyOwnedStructurePosition(): Position {
    return {
        instrument: "VS:BEAR_CALL_CREDIT:NVDA:2026-07-31",
        providerPositionId: "legacy-nvda-bear-call",
        side: "short",
        quantity: 1,
        entryPrice: 0.5,
        metadata: {
            spreadWidth: 2.5,
        },
    }
}

function createBearCallLegs(args: {
    underlying: string
    expiration: string
    shortStrike: number
    longStrike: number
    action: "entry" | "close"
}): NonNullable<OrderIntent["legs"]> {
    const shortLegSide = args.action === "entry" ? "sell_to_open" : "buy_to_close"
    const longLegSide = args.action === "entry" ? "buy_to_open" : "sell_to_close"

    return [
        {
            instrument: createOptionSymbol(args.underlying, args.expiration, "call", args.shortStrike),
            side: shortLegSide,
            quantity: 1,
        },
        {
            instrument: createOptionSymbol(args.underlying, args.expiration, "call", args.longStrike),
            side: longLegSide,
            quantity: 1,
        },
    ]
}

function createOptionSymbol(
    underlying: string,
    expiration: string,
    optionType: "call" | "put",
    strike: number
): string {
    const datePart = expiration.slice(2).replaceAll("-", "")
    const typePart = optionType === "call" ? "C" : "P"
    const strikePart = String(Math.round(strike * 1000)).padStart(8, "0")
    return `${underlying}${datePart}${typePart}${strikePart}`
}
