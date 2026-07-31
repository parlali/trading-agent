import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTradingBackendClient } from "./trading-backend-client"

const convexMocks = vi.hoisted(() => ({
    mutation: vi.fn(),
    query: vi.fn(),
    action: vi.fn(),
}))

vi.mock("convex/browser", () => ({
    ConvexHttpClient: class MockConvexHttpClient {
        mutation = convexMocks.mutation
        query = convexMocks.query
        action = convexMocks.action
    },
}))

describe("Trading backend Convex provider reconciliation retry", () => {
    beforeEach(() => {
        convexMocks.mutation.mockReset()
        convexMocks.query.mockReset()
        convexMocks.action.mockReset()
    })

    it("retries transient Convex OCC for provider reconciliation", async () => {
        const warn = vi.fn()
        const result = {
            app: "alpaca-options",
            accountId: "primary",
            source: "post_run_sync",
            positionCount: 0,
            pendingOrderCount: 0,
            driftDetected: false,
        }
        convexMocks.mutation
            .mockRejectedValueOnce(new Error(
                "OptimisticConcurrencyControlFailure: Documents read from or written to the instrument_claims table changed"
            ))
            .mockResolvedValueOnce(result)
        const client = createTradingBackendClient({
            url: "https://convex.test",
            machineAuth: {
                serviceToken: "test-token",
            },
            mutationRetry: {
                attempts: 3,
                delayMs: 0,
            },
            logger: { warn },
        })

        await expect(client.reconcileProviderPortfolio(
            "alpaca-options",
            "primary",
            "alpaca",
            "post_run_sync",
            createAccountState(),
            [],
            []
        )).resolves.toBe(result)

        expect(convexMocks.mutation).toHaveBeenCalledTimes(2)
        expect(warn).toHaveBeenCalledWith(
            "Retrying Convex provider reconciliation mutation after transient failure",
            expect.objectContaining({
                app: "alpaca-options",
                accountId: "primary",
                source: "post_run_sync",
                attempt: 1,
                attempts: 3,
                error: expect.stringContaining("OptimisticConcurrencyControlFailure"),
            })
        )
    })

    it("fails closed after exhausted provider reconciliation OCC retries", async () => {
        const warn = vi.fn()
        const error = new Error(
            "OptimisticConcurrencyControlFailure: Documents read from or written to the instrument_claims table changed"
        )
        convexMocks.mutation.mockRejectedValue(error)
        const client = createTradingBackendClient({
            url: "https://convex.test",
            machineAuth: {
                serviceToken: "test-token",
            },
            mutationRetry: {
                attempts: 2,
                delayMs: 0,
            },
            logger: { warn },
        })

        await expect(client.reconcileProviderPortfolio(
            "alpaca-options",
            "primary",
            "alpaca",
            "post_run_sync",
            createAccountState(),
            [],
            []
        )).rejects.toThrow("OptimisticConcurrencyControlFailure")

        expect(convexMocks.mutation).toHaveBeenCalledTimes(2)
        expect(warn).toHaveBeenCalledTimes(1)
    })
})

function createAccountState() {
    return {
        balance: 100000,
        equity: 100000,
        buyingPower: 100000,
        marginUsed: 0,
        marginAvailable: 100000,
        openPnl: 0,
        dayPnl: 0,
    }
}
