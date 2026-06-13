import { describe, expect, it } from "vitest"
import { validateIntent, type AccountState, type OrderIntent, type Position } from "@valiq-trading/core"
import { polymarketRiskValidators } from "./risk-rules.ts"

const account: AccountState = {
    balance: 1000,
    equity: 1000,
    buyingPower: 1000,
    marginUsed: 0,
    marginAvailable: 1000,
    openPnl: 0,
    dayPnl: 0,
}

const basePolicy = {
    dryRun: true,
    llm: {
        provider: "openrouter",
        model: "gpt",
    },
    maxBet: {
        mode: "fixed",
        value: 5,
    },
    minLiquidity: 100,
    minResolutionBufferHours: 48,
    allowedCategories: ["politics"],
    maxTotalExposure: 20,
}

function createIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
    return {
        instrument: "token-yes",
        side: "buy",
        quantity: 10,
        orderType: "market",
        timeInForce: "gtc",
        metadata: {
            tokenId: "token-yes",
            conditionId: "condition-1",
            marketSlug: "market-1",
            question: "Will it happen?",
            outcome: "Yes",
            category: "politics",
            endDateIso: "2099-01-01T00:00:00.000Z",
            liquidity: 1000,
            estimatedPrice: 0.7,
        },
        ...overrides,
    }
}

describe("polymarketRiskValidators", () => {
    it("rejects unsupported stop and day order semantics before execution", () => {
        const cases: Array<{
            name: string
            intent: Partial<OrderIntent>
            reason: string
        }> = [
            {
                name: "stop order",
                intent: {
                    orderType: "stop",
                    stopPrice: 0.45,
                    timeInForce: "gtc",
                },
                reason: "supports only market and limit",
            },
            {
                name: "stop-limit order",
                intent: {
                    orderType: "stop_limit",
                    limitPrice: 0.5,
                    stopPrice: 0.45,
                    timeInForce: "gtc",
                },
                reason: "supports only market and limit",
            },
            {
                name: "day time in force",
                intent: {
                    orderType: "limit",
                    limitPrice: 0.5,
                    timeInForce: "day",
                },
                reason: "timeInForce=day",
            },
        ]

        for (const testCase of cases) {
            const validation = validateIntent(
                createIntent(testCase.intent),
                basePolicy,
                account,
                [],
                polymarketRiskValidators
            )

            expect(validation.allowed, testCase.name).toBe(false)
            expect(validation.reason).toContain(testCase.reason)
        }
    })

    it("does not block sell-side exits because stale entry constraints are now violated", () => {
        const position: Position = {
            instrument: "token-yes",
            side: "long",
            quantity: 10,
            entryPrice: 0.8,
            currentPrice: 0.5,
        }
        const validation = validateIntent(
            createIntent({
                side: "sell",
                quantity: 10,
                orderType: "limit",
                limitPrice: 0.5,
                timeInForce: "ioc",
                metadata: {
                    tokenId: "token-yes",
                    conditionId: "condition-1",
                    marketSlug: "market-1",
                    question: "Will it happen?",
                    outcome: "Yes",
                    category: "sports",
                    endDateIso: "2020-01-01T00:00:00.000Z",
                    liquidity: 0,
                },
            }),
            basePolicy,
            account,
            [position],
            polymarketRiskValidators
        )

        expect(validation.allowed).toBe(true)
    })
})
