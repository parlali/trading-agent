import { describe, expect, it, vi } from "vitest"
import {
    assertFullResetAuditClean,
    assertNoProviderExposureBeforeCleanup,
    finalizeFullResetCleanup,
} from "./strategy-cli.ts"
import type { TradingBackendClient } from "@valiq-trading/convex"

describe("finalizeFullResetCleanup", () => {
    it("combines orphan cleanup, app-state cleanup, and final audit", async () => {
        const calls: string[] = []
        const client = {
            deleteOrphanedStrategyHistoryBatch: vi.fn().mockImplementation(async () => {
                calls.push("deleteOrphanedStrategyHistoryBatch")
                return {
                    runs: 1,
                    agentLogs: 2,
                    tradeEvents: 0,
                    orders: 0,
                    orderTransitions: 0,
                    positions: 0,
                    instrumentClaims: 0,
                    positionSyncs: 0,
                    providerPositions: 0,
                    providerWorkingOrders: 0,
                    providerSyncStates: 0,
                    accountSnapshots: 0,
                    appHeartbeats: 0,
                    manualRunRequests: 0,
                    alerts: 0,
                    hasMore: false,
                }
            }),
            getPortfolioPositions: vi.fn().mockImplementation(async () => {
                calls.push("getPortfolioPositions")
                return []
            }),
            getPortfolioPendingOrders: vi.fn().mockImplementation(async () => {
                calls.push("getPortfolioPendingOrders")
                return []
            }),
            clearFullResetState: vi.fn().mockImplementation(async () => {
                calls.push("clearFullResetState")
                return {
                    runs: 0,
                    agentLogs: 0,
                    tradeEvents: 0,
                    orders: 0,
                    orderTransitions: 0,
                    positions: 0,
                    instrumentClaims: 0,
                    positionSyncs: 0,
                    providerPositions: 0,
                    providerWorkingOrders: 0,
                    providerSyncStates: 1,
                    accountSnapshots: 3,
                    appHeartbeats: 2,
                    manualRunRequests: 0,
                    alerts: 4,
                }
            }),
            getFullResetAudit: vi.fn().mockImplementation(async () => {
                calls.push("getFullResetAudit")
                return {
                    strategies: 0,
                    runs: 0,
                    agentLogs: 0,
                    tradeEvents: 0,
                    orders: 0,
                    orderTransitions: 0,
                    positions: 0,
                    instrumentClaims: 0,
                    positionSyncs: 0,
                    providerPositions: 0,
                    providerWorkingOrders: 0,
                    providerSyncStates: 0,
                    accountSnapshots: 0,
                    appHeartbeats: 0,
                    manualRunRequests: 0,
                    alerts: 0,
                }
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
        expect(client.clearFullResetState).toHaveBeenCalledOnce()
        expect(client.getFullResetAudit).toHaveBeenCalledOnce()
        expect(calls).toEqual([
            "getPortfolioPositions",
            "getPortfolioPendingOrders",
            "deleteOrphanedStrategyHistoryBatch",
            "clearFullResetState",
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
            clearFullResetState: vi.fn(),
            getFullResetAudit: vi.fn(),
        } as unknown as TradingBackendClient

        await expect(
            finalizeFullResetCleanup(client)
        ).rejects.toThrow("Refusing to clear provider state while live provider exposure remains in Convex")

        expect(client.deleteOrphanedStrategyHistoryBatch).not.toHaveBeenCalled()
        expect(client.clearFullResetState).not.toHaveBeenCalled()
        expect(client.getFullResetAudit).not.toHaveBeenCalled()
    })
})

describe("assertNoProviderExposureBeforeCleanup", () => {
    it("fails closed when provider positions or orders still exist", async () => {
        const client = {
            getPortfolioPositions: vi.fn().mockResolvedValue([
                {
                    app: "polymarket",
                    instrument: "token-1",
                    ownershipStatus: "unowned",
                },
            ]),
            getPortfolioPendingOrders: vi.fn().mockResolvedValue([
                {
                    app: "polymarket",
                    orderId: "order-1",
                    instrument: "token-1",
                    ownershipStatus: "unowned",
                },
            ]),
        } as unknown as TradingBackendClient

        await expect(
            assertNoProviderExposureBeforeCleanup(client)
        ).rejects.toThrow("Refusing to clear provider state while live provider exposure remains in Convex")
    })
})

describe("assertFullResetAuditClean", () => {
    it("throws when any residual rows remain after cleanup", () => {
        expect(() => assertFullResetAuditClean({
            strategies: 0,
            runs: 0,
            agentLogs: 0,
            tradeEvents: 0,
            orders: 0,
            orderTransitions: 0,
            positions: 0,
            instrumentClaims: 0,
            positionSyncs: 0,
            providerPositions: 0,
            providerWorkingOrders: 0,
            providerSyncStates: 0,
            accountSnapshots: 0,
            appHeartbeats: 0,
            manualRunRequests: 0,
            alerts: 2,
        })).toThrow("Residual Convex state remains")
    })
})
