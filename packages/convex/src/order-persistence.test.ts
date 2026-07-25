import { describe, expect, it } from "vitest"
import type { OrderSnapshot } from "@valiq-trading/core"
import { createConvexOrderPersistenceAdapter } from "./order-persistence"

describe("Convex order persistence write retries", () => {
    it("retries transient Convex server errors for order pre-writes", async () => {
        let attempts = 0

        const adapter = createConvexOrderPersistenceAdapter({
            url: "https://convex.test",
            machineAuth: {
                serviceToken: "test-token",
            },
            writeRetry: {
                attempts: 3,
                delayMs: 0,
            },
            mutationLock: async <T>() => {
                attempts++
                if (attempts === 1) {
                    throw new Error("Server Error")
                }
                return undefined as T
            },
        })

        await adapter.upsertOrder(createSnapshot())

        expect(attempts).toBe(2)
    })

    it("fails closed after exhausted bounded write retries", async () => {
        let attempts = 0
        const adapter = createConvexOrderPersistenceAdapter({
            url: "https://convex.test",
            machineAuth: {
                serviceToken: "test-token",
            },
            writeRetry: {
                attempts: 2,
                delayMs: 0,
            },
            mutationLock: async <T>() => {
                attempts++
                throw new Error("Server Error")
            },
        })

        await expect(adapter.upsertOrder(createSnapshot())).rejects.toThrow("Server Error")

        expect(attempts).toBe(2)
    })
})

function createSnapshot(): OrderSnapshot {
    return {
        orderId: "vmte01prewritezz",
        canonicalOrderId: "vmte01prewritezz",
        providerOrderId: "",
        providerClientOrderId: "vmte01prewritezz",
        providerOrderAliases: [],
        submitAttemptId: "attempt-1",
        submitAttemptSequence: 1,
        commitOutcome: "commit_unknown",
        strategyId: "strategy-1",
        runId: "run-1",
        accountId: "primary",
        instrument: "US30",
        status: "pending",
        action: "entry",
        quantity: 0.1,
        filledQuantity: 0,
        remainingQuantity: 0.1,
        submittedAt: 1_784_899_609_539,
        updatedAt: 1_784_899_609_539,
        venue: "mt5",
        intent: {
            instrument: "US30",
            side: "sell",
            quantity: 0.1,
            orderType: "limit",
            limitPrice: 51980,
            timeInForce: "day",
        },
        lastTransitionSequence: 0,
        polling: {
            pollIntervalMs: 5_000,
            timeoutMs: 120_000,
            startedAt: 1_784_899_609_539,
            lastCheckedAt: 1_784_899_609_539,
            nextCheckAt: 1_784_899_614_539,
        },
    }
}
