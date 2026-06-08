import { describe, expect, it, vi } from "vitest"
import {
    assertFullResetAuditClean,
    finalizeFullResetCleanup,
    resolveArg,
    resolveFlag,
    resolvePositiveIntegerArg,
} from "./strategy-cli.ts"
import type { TradingBackendClient } from "@valiq-trading/convex"

function createResetCounts(overrides: Record<string, number | boolean> = {}) {
    return {
        runs: 0,
        agentLogs: 0,
        tradeEvents: 0,
        orders: 0,
        orderTransitions: 0,
        positions: 0,
        instrumentClaims: 0,
        positionSyncs: 0,
        strategyRiskStates: 0,
        executionSafetyFaults: 0,
        providerPositions: 0,
        providerWorkingOrders: 0,
        providerSyncStates: 0,
        accountSnapshots: 0,
        appHeartbeats: 0,
        manualRunRequests: 0,
        alerts: 0,
        strategies: 0,
        ...overrides,
    }
}

describe("script argument parsing", () => {
    it("supports equals arguments, space-separated arguments, and boolean flags", () => {
        const originalArgv = process.argv
        process.argv = [
            "bun",
            "script.ts",
            "--model=codex-test",
            "--strategy",
            "strategy-123",
            "--dry-run-only",
        ]

        try {
            expect(resolveArg("model")).toBe("codex-test")
            expect(resolveArg("strategy")).toBe("strategy-123")
            expect(resolveArg("dry-run-only")).toBeUndefined()
            expect(resolveFlag("dry-run-only")).toBe(true)
        } finally {
            process.argv = originalArgv
        }
    })

    it("resolves bounded positive integer arguments", () => {
        const originalArgv = process.argv
        process.argv = [
            "bun",
            "script.ts",
            "--timeout-ms=120000",
        ]

        try {
            expect(resolvePositiveIntegerArg("timeout-ms", 30000, {
                min: 1000,
                max: 600000,
            })).toBe(120000)
            expect(resolvePositiveIntegerArg("missing", 3, {
                min: 1,
                max: 50,
            })).toBe(3)
        } finally {
            process.argv = originalArgv
        }
    })

    it("rejects non-integer, below-minimum, and above-maximum numeric arguments", () => {
        const originalArgv = process.argv

        try {
            process.argv = ["bun", "script.ts", "--timeout-ms=abc"]
            expect(() => resolvePositiveIntegerArg("timeout-ms", 120000, {
                min: 1000,
                max: 600000,
            })).toThrow("--timeout-ms must be a positive integer between 1000 and 600000")

            process.argv = ["bun", "script.ts", "--timeout-ms=0"]
            expect(() => resolvePositiveIntegerArg("timeout-ms", 120000, {
                min: 1000,
                max: 600000,
            })).toThrow("--timeout-ms must be a positive integer between 1000 and 600000")

            process.argv = ["bun", "script.ts", "--timeout-ms=900000"]
            expect(() => resolvePositiveIntegerArg("timeout-ms", 120000, {
                min: 1000,
                max: 600000,
            })).toThrow("--timeout-ms must be a positive integer between 1000 and 600000")
        } finally {
            process.argv = originalArgv
        }
    })
})

describe("finalizeFullResetCleanup", () => {
    it("combines orphan cleanup, app-state cleanup, and final audit", async () => {
        const calls: string[] = []
        const client = {
            deleteOrphanedStrategyHistoryBatch: vi.fn().mockImplementation(async () => {
                calls.push("deleteOrphanedStrategyHistoryBatch")
                return createResetCounts({
                    runs: 1,
                    agentLogs: 2,
                    hasMore: false,
                })
            }),
            getPortfolioPositions: vi.fn().mockImplementation(async () => {
                calls.push("getPortfolioPositions")
                return []
            }),
            getPortfolioPendingOrders: vi.fn().mockImplementation(async () => {
                calls.push("getPortfolioPendingOrders")
                return []
            }),
            clearFullResetStateBatch: vi.fn().mockImplementation(async () => {
                calls.push("clearFullResetStateBatch")
                return createResetCounts({
                    providerSyncStates: 1,
                    accountSnapshots: 3,
                    appHeartbeats: 2,
                    alerts: 4,
                    hasMore: false,
                })
            }),
            getFullResetAudit: vi.fn().mockImplementation(async () => {
                calls.push("getFullResetAudit")
                return createResetCounts({
                    strategies: 0,
                })
            }),
        } as unknown as TradingBackendClient

        const result = await finalizeFullResetCleanup(client)

        expect(result.deleted).toMatchObject({
            runs: 1,
            agentLogs: 2,
            providerSyncStates: 1,
            accountSnapshots: 3,
            appHeartbeats: 2,
            alerts: 4,
        })
        expect(client.deleteOrphanedStrategyHistoryBatch).toHaveBeenCalledOnce()
        expect(client.clearFullResetStateBatch).toHaveBeenCalledOnce()
        expect(client.getFullResetAudit).toHaveBeenCalledOnce()
        expect(calls).toEqual([
            "getPortfolioPositions",
            "getPortfolioPendingOrders",
            "deleteOrphanedStrategyHistoryBatch",
            "clearFullResetStateBatch",
            "getFullResetAudit",
        ])
    })

    it("fails before orphan cleanup when deleted strategies still have live provider exposure", async () => {
        const client = {
            getPortfolioPositions: vi.fn().mockResolvedValue([
                {
                    app: "polymarket",
                    strategyId: undefined,
                    strategyName: undefined,
                    instrument: "token-1",
                    ownershipStatus: "orphaned",
                },
            ]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([]),
            deleteOrphanedStrategyHistoryBatch: vi.fn(),
            clearFullResetStateBatch: vi.fn(),
            getFullResetAudit: vi.fn(),
        } as unknown as TradingBackendClient

        await expect(
            finalizeFullResetCleanup(client)
        ).rejects.toThrow("Refusing to clear provider state while live provider exposure remains in Convex")

        expect(client.deleteOrphanedStrategyHistoryBatch).not.toHaveBeenCalled()
        expect(client.clearFullResetStateBatch).not.toHaveBeenCalled()
        expect(client.getFullResetAudit).not.toHaveBeenCalled()
    })

    it("allows explicitly deferred provider exposure during cleanup", async () => {
        const client = {
            deleteOrphanedStrategyHistoryBatch: vi.fn().mockResolvedValue(createResetCounts({
                hasMore: false,
            })),
            getPortfolioPositions: vi.fn().mockResolvedValue([
                {
                    app: "alpaca-options",
                    instrument: "SPY-IC",
                    ownershipStatus: "owned",
                },
            ]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([
                {
                    app: "alpaca-options",
                    orderId: "close-order-1",
                    instrument: "SPY-IC",
                    ownershipStatus: "owned",
                },
            ]),
            clearFullResetStateBatch: vi.fn().mockResolvedValue(createResetCounts({
                hasMore: false,
            })),
            getFullResetAudit: vi.fn().mockResolvedValue(createResetCounts({
                strategies: 1,
                providerPositions: 1,
                providerWorkingOrders: 1,
            })),
        } as unknown as TradingBackendClient

        await expect(
            finalizeFullResetCleanup(client, {
                allowedProviderExposureApps: ["alpaca-options"],
            })
        ).resolves.toMatchObject({
            audit: {
                providerPositions: 1,
                providerWorkingOrders: 1,
            },
        })

        expect(client.deleteOrphanedStrategyHistoryBatch).not.toHaveBeenCalled()
        expect(client.clearFullResetStateBatch).toHaveBeenCalledOnce()
        expect(client.clearFullResetStateBatch).toHaveBeenCalledWith(20, ["alpaca-options"])
    })
})

describe("assertFullResetAuditClean", () => {
    it("throws when any residual rows remain after cleanup", () => {
        expect(() => assertFullResetAuditClean(createResetCounts({
            strategies: 0,
            alerts: 2,
        }))).toThrow("Residual Convex state remains")
    })
})
