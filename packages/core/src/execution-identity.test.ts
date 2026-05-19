import { describe, expect, it } from "vitest"
import {
    createChildExecutionIdentity,
    createExecutionIdentity,
    getExecutionIdentityCandidates,
} from "./execution-identity.ts"

describe("execution identity", () => {
    it("creates deterministic venue-safe canonical ids", () => {
        const input = {
            venue: "mt5",
            strategyId: "strategy-1",
            runId: "run-1",
            role: "entry" as const,
            instrument: "XAUUSD",
            sequence: 1,
            normalizedIntent: {
                instrument: "XAUUSD",
                side: "buy",
                quantity: 0.01,
                orderType: "limit",
                limitPrice: 4715.5,
            },
        }

        const left = createExecutionIdentity(input)
        const right = createExecutionIdentity(input)

        expect(left.canonicalOrderId).toBe(right.canonicalOrderId)
        expect(left.canonicalOrderId).toMatch(/^vmte01[a-z2-7]{10}$/)
        expect(left.canonicalOrderId).toHaveLength(16)
        expect(left.providerClientOrderId).toBe(left.canonicalOrderId)
        expect(left.submitAttemptId).toBe(right.submitAttemptId)
        expect(left.submitAttemptSequence).toBe(1)
    })

    it("creates deterministic attempt ids and stable distinct OKX child ids from explicit sequences", () => {
        const input = {
            venue: "okx-swap",
            strategyId: "strategy-1",
            runId: "run-1",
            role: "entry" as const,
            instrument: "BTC-USDT-SWAP",
            sequence: 7,
            attemptSequence: 2,
            normalizedIntent: {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                quantity: 0.1,
                orderType: "market",
            },
        }
        const identity = createExecutionIdentity(input)
        const recreated = createExecutionIdentity(input)
        const nextAttempt = createExecutionIdentity({
            ...input,
            attemptSequence: 3,
        })
        const takeProfit = createChildExecutionIdentity(identity, "take_profit")
        const stopLoss = createChildExecutionIdentity(identity, "stop_loss")
        const recreatedTakeProfit = createChildExecutionIdentity(recreated, "take_profit")

        expect(identity.canonicalOrderId).toBe(recreated.canonicalOrderId)
        expect(identity.submitAttemptId).toBe(recreated.submitAttemptId)
        expect(identity.submitAttemptId).not.toBe(nextAttempt.submitAttemptId)
        expect(takeProfit.providerClientOrderId).toBe(recreatedTakeProfit.providerClientOrderId)
        expect(takeProfit.providerClientOrderId).not.toBe(stopLoss.providerClientOrderId)
        expect(takeProfit.providerClientOrderId).toMatch(/^vokt07[a-z2-7]{10}$/)
        expect(stopLoss.providerClientOrderId).toMatch(/^voks07[a-z2-7]{10}$/)
    })

    it("dedupes canonical, provider, client, alias, and signed fingerprint candidates", () => {
        expect(getExecutionIdentityCandidates({
            orderId: "canonical",
            canonicalOrderId: "canonical",
            providerOrderId: "provider",
            providerClientOrderId: "client",
            providerOrderAliases: ["provider", "alias"],
            signedOrderFingerprint: "fingerprint",
        })).toEqual(["alias", "canonical", "client", "fingerprint", "provider"])
    })

    it("keeps canonical ids stable across volatile runtime metadata", () => {
        const input = {
            venue: "okx-swap",
            strategyId: "strategy-1",
            runId: "run-1",
            role: "entry" as const,
            instrument: "BTC-USDT-SWAP",
            sequence: 1,
            normalizedIntent: {
                instrument: "BTC-USDT-SWAP",
                side: "buy",
                quantity: 0.1,
                orderType: "limit",
                limitPrice: 100,
                metadata: {
                    stopLoss: 95,
                    takeProfit: 110,
                    cancelAt: 1_777_777_000_000,
                    estimatedPrice: 100,
                    fundingRate: 0.001,
                    estimatedRoundTripFees: 0.5,
                    riskAmount: 10,
                    riskPercent: 0.1,
                },
            },
        }

        const first = createExecutionIdentity(input)
        const second = createExecutionIdentity({
            ...input,
            normalizedIntent: {
                ...input.normalizedIntent,
                metadata: {
                    ...input.normalizedIntent.metadata,
                    cancelAt: 1_777_778_000_000,
                    estimatedPrice: 101,
                    fundingRate: 0.002,
                    estimatedRoundTripFees: 0.7,
                    riskAmount: 11,
                    riskPercent: 0.11,
                },
            },
        })
        const changedProtection = createExecutionIdentity({
            ...input,
            normalizedIntent: {
                ...input.normalizedIntent,
                metadata: {
                    ...input.normalizedIntent.metadata,
                    stopLoss: 94,
                },
            },
        })

        expect(second.canonicalOrderId).toBe(first.canonicalOrderId)
        expect(changedProtection.canonicalOrderId).not.toBe(first.canonicalOrderId)
    })
})
