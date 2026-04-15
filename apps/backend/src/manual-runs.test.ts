import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = {
    backend: {
        claimManualRunRequests: vi.fn(),
        ackManualRunRequest: vi.fn(),
        getStrategyById: vi.fn(),
    },
    logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    setManualRunPollTimer: vi.fn(),
    setManualRunPollInFlight: vi.fn(),
    registerStrategyWithScheduler: vi.fn(),
    pendingManualTriggers: new Set<string>(),
}

vi.mock("./state", () => ({
    MANUAL_RUN_POLL_INTERVAL_MS: 5_000,
    MANUAL_RUN_LEASE_MS: 30_000,
    MANUAL_RUN_MAX_ATTEMPTS: 5,
    MANUAL_RUN_CLAIM_LIMIT: 25,
    MANUAL_RUN_WORKER_ID: "backend-worker-test",
    ALL_APPS: ["polymarket"],
    backend: mocks.backend,
    logger: mocks.logger,
    manualRunPollTimer: null,
    manualRunPollInFlight: false,
    setManualRunPollTimer: mocks.setManualRunPollTimer,
    setManualRunPollInFlight: mocks.setManualRunPollInFlight,
}))

vi.mock("./scheduler", () => ({
    registerStrategyWithScheduler: mocks.registerStrategyWithScheduler,
    pendingManualTriggers: mocks.pendingManualTriggers,
}))

describe("pollManualRunRequests", () => {
    beforeEach(() => {
        mocks.backend.claimManualRunRequests.mockReset()
        mocks.backend.ackManualRunRequest.mockReset()
        mocks.backend.getStrategyById.mockReset()
        mocks.logger.error.mockReset()
        mocks.logger.info.mockReset()
        mocks.logger.warn.mockReset()
        mocks.registerStrategyWithScheduler.mockReset()
        mocks.pendingManualTriggers.clear()
    })

    it("claims and dispatches a manual run, then acks completion", async () => {
        const { pollManualRunRequests } = await import("./manual-runs.ts")
        mocks.backend.claimManualRunRequests.mockResolvedValue({
            app: "polymarket",
            claimed: [
                {
                    _id: "req-1",
                    strategyId: "strategy-1",
                    app: "polymarket",
                    requestedAt: Date.now(),
                    attemptCount: 0,
                    leaseExpiresAt: Date.now() + 30_000,
                },
            ],
            contentionCount: 0,
            terminalizedCount: 0,
            maxAttempts: 5,
            leaseMs: 30_000,
        })

        const scheduler = {
            getRegisteredStrategies: () => ["strategy-1"],
            isRunning: vi.fn().mockReturnValue(false),
            triggerManual: vi.fn().mockResolvedValue(undefined),
        }

        await pollManualRunRequests(scheduler as never)

        expect(scheduler.triggerManual).toHaveBeenCalledWith("strategy-1")
        expect(mocks.backend.ackManualRunRequest).toHaveBeenCalledWith({
            requestId: "req-1",
            workerId: "backend-worker-test",
            outcome: "completed",
            error: undefined,
            maxAttempts: 5,
        })
    })

    it("requeues when strategy is already running", async () => {
        const { pollManualRunRequests } = await import("./manual-runs.ts")
        mocks.backend.claimManualRunRequests.mockResolvedValue({
            app: "polymarket",
            claimed: [
                {
                    _id: "req-1",
                    strategyId: "strategy-1",
                    app: "polymarket",
                    requestedAt: Date.now(),
                    attemptCount: 0,
                    leaseExpiresAt: Date.now() + 30_000,
                },
            ],
            contentionCount: 0,
            terminalizedCount: 0,
            maxAttempts: 5,
            leaseMs: 30_000,
        })

        const scheduler = {
            getRegisteredStrategies: () => ["strategy-1"],
            isRunning: vi.fn().mockReturnValue(true),
            triggerManual: vi.fn(),
        }

        await pollManualRunRequests(scheduler as never)

        expect(scheduler.triggerManual).not.toHaveBeenCalled()
        expect(mocks.backend.ackManualRunRequest).toHaveBeenCalledWith({
            requestId: "req-1",
            workerId: "backend-worker-test",
            outcome: "requeue",
            error: "Strategy run already in progress",
            maxAttempts: 5,
        })
    })

    it("acks terminal failure when strategy has been deleted", async () => {
        const { pollManualRunRequests } = await import("./manual-runs.ts")
        mocks.backend.claimManualRunRequests.mockResolvedValue({
            app: "polymarket",
            claimed: [
                {
                    _id: "req-1",
                    strategyId: "strategy-1",
                    app: "polymarket",
                    requestedAt: Date.now(),
                    attemptCount: 0,
                    leaseExpiresAt: Date.now() + 30_000,
                },
            ],
            contentionCount: 0,
            terminalizedCount: 0,
            maxAttempts: 5,
            leaseMs: 30_000,
        })
        mocks.backend.getStrategyById.mockResolvedValue(null)

        const scheduler = {
            getRegisteredStrategies: () => [],
            isRunning: vi.fn().mockReturnValue(false),
            triggerManual: vi.fn(),
        }

        await pollManualRunRequests(scheduler as never)

        expect(mocks.backend.ackManualRunRequest).toHaveBeenCalledWith({
            requestId: "req-1",
            workerId: "backend-worker-test",
            outcome: "terminal_failure",
            error: "Strategy no longer exists",
            maxAttempts: 5,
        })
    })

    it("acks retryable failure when scheduler dispatch throws", async () => {
        const { pollManualRunRequests } = await import("./manual-runs.ts")
        mocks.backend.claimManualRunRequests.mockResolvedValue({
            app: "polymarket",
            claimed: [
                {
                    _id: "req-1",
                    strategyId: "strategy-1",
                    app: "polymarket",
                    requestedAt: Date.now(),
                    attemptCount: 0,
                    leaseExpiresAt: Date.now() + 30_000,
                },
            ],
            contentionCount: 0,
            terminalizedCount: 0,
            maxAttempts: 5,
            leaseMs: 30_000,
        })

        const scheduler = {
            getRegisteredStrategies: () => ["strategy-1"],
            isRunning: vi.fn().mockReturnValue(false),
            triggerManual: vi.fn().mockRejectedValue(new Error("convex timeout")),
        }

        await pollManualRunRequests(scheduler as never)

        expect(mocks.backend.ackManualRunRequest).toHaveBeenCalledWith({
            requestId: "req-1",
            workerId: "backend-worker-test",
            outcome: "retryable_failure",
            error: "convex timeout",
            maxAttempts: 5,
        })
    })
})
