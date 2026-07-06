import { describe, expect, it } from "vitest"
import { validateIntent, type AccountState, type OrderIntent, type Position } from "@valiq-trading/core"
import { okxRiskValidators } from "./risk-rules"

const account: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const positions: Position[] = []

const policy = {
    dryRun: true,
    llm: {
        provider: "openrouter",
        model: "gpt-5.4",
    },
    safety: {
        sessionFlat: {
            enabled: false,
            closeBufferMinutes: 15,
            timezone: "UTC",
        },
    },
    allowedInstruments: ["BTC-USDT-SWAP"],
    maxLeverage: 3,
    maxRiskPercent: 1,
    tradingHours: {
        start: "00:00",
        end: "23:59",
        timezone: "UTC",
    },
    fundingRateThreshold: 0.01,
    requireTakeProfit: false,
}

function entryIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
    return {
        instrument: "BTC-USDT-SWAP",
        side: "buy",
        quantity: 1,
        orderType: "market",
        timeInForce: "gtc",
        metadata: {
            action: "entry",
            stopLoss: 50_000,
            takeProfit: 70_000,
            riskPercent: 0.5,
        },
        ...overrides,
    }
}

describe("okxRiskValidators", () => {
    it("rejects entry intents with bounded OKX execution guardrail violations", () => {
        const cases = [
            {
                intent: entryIntent({ timeInForce: "day" }),
                reason: "timeInForce=day",
            },
            {
                intent: entryIntent({ metadata: { action: "entry" } }),
                reason: "require stopLoss",
            },
        ]

        for (const testCase of cases) {
            const result = validateIntent(
                testCase.intent,
                policy,
                account,
                positions,
                okxRiskValidators
            )

            expect(result.allowed).toBe(false)
            expect(result.reason).toContain(testCase.reason)
        }
    })

    it("allows close intents without stopLoss", () => {
        const result = validateIntent(
            entryIntent({
                side: "sell",
                metadata: {
                    action: "close",
                },
            }),
            policy,
            account,
            positions,
            okxRiskValidators
        )

        expect(result.allowed).toBe(true)
    })

    it("blocks only funding carry that is hostile to the proposed side", () => {
        const positiveFundingShort = validateIntent(
            entryIntent({
                side: "sell",
                metadata: {
                    action: "entry",
                    stopLoss: 70_000,
                    takeProfit: 50_000,
                    riskPercent: 0.5,
                    fundingRate: 0.02,
                },
            }),
            policy,
            account,
            positions,
            okxRiskValidators
        )
        const positiveFundingLong = validateIntent(
            entryIntent({
                side: "buy",
                metadata: {
                    action: "entry",
                    stopLoss: 50_000,
                    takeProfit: 70_000,
                    riskPercent: 0.5,
                    fundingRate: 0.02,
                },
            }),
            policy,
            account,
            positions,
            okxRiskValidators
        )

        expect(positiveFundingShort.allowed).toBe(true)
        expect(positiveFundingLong.allowed).toBe(false)
        expect(positiveFundingLong.reason).toContain("hostile to buy exposure")
    })

    it("rejects OKX entries with stops inside cost noise and allows sufficient structure", () => {
        const gatedPolicy = {
            ...policy,
            minRiskReward: 2,
            minStopDistancePercent: 0.4,
        }
        const noisyStopIntent = entryIntent({
            metadata: {
                action: "entry",
                estimatedPrice: 60_000,
                stopLoss: 59_820,
                takeProfit: 60_180,
                riskPercent: 0.5,
            },
        })
        const structuralIntent = entryIntent({
            metadata: {
                action: "entry",
                estimatedPrice: 60_000,
                stopLoss: 59_700,
                takeProfit: 60_700,
                riskPercent: 0.5,
            },
        })

        const rejected = validateIntent(
            noisyStopIntent,
            gatedPolicy,
            account,
            positions,
            okxRiskValidators
        )
        const allowed = validateIntent(
            structuralIntent,
            gatedPolicy,
            account,
            positions,
            okxRiskValidators
        )

        expect(rejected.allowed).toBe(false)
        expect(rejected.reason).toContain("Stop distance 0.30% of entry is below the minimum 0.4%")
        expect(allowed.allowed).toBe(true)
    })
})
