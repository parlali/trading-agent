import { describe, expect, it } from "vitest"
import { createEmptyCascadeDeleteCounts } from "../../convex/lib/cascadeDelete"
import {
    operatorReconcileVerifiedFlatProviderState,
    reconcileProviderPortfolio,
} from "../../convex/lib/mutations/portfolio"
import { refreshStrategyRiskState } from "../../convex/lib/mutations/risk"
import {
    assertStrategyDeletionSafe,
    cascadeDeleteStrategy,
    deleteFinalStrategyAccountRows,
    deleteFinalStrategyAppRows,
    deleteStrategyTableBatch,
} from "../../convex/lib/mutations/strategyCascadeDelete"
import { buildStrategyPositionSnapshotHashPayload } from "../../convex/lib/mutations/portfolioSnapshots"
import { callRegistered, FakeMutationDb } from "./fakeMutationDb"

type RowsByTable = Record<string, unknown[] | undefined>

function createDeletionSafetyCtx(rows: RowsByTable) {
    return {
        db: {
            query(table: string) {
                const tableRows = rows[table] ?? []

                return {
                    withIndex() {
                        return {
                            async first() {
                                return tableRows[0] ?? null
                            },
                            async collect() {
                                return tableRows
                            },
                        }
                    },
                }
            },
        },
    }
}

function createLiveStrategy() {
    return {
        _id: "strategy-live",
        app: "mt5",
        accountId: "acct-1",
        policy: {
            dryRun: false,
        },
    }
}

describe("portfolio safety guards", () => {
    it("fails closed when deleting a live strategy without provider verification state", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({}) as never, createLiveStrategy() as never))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("allows force reset to delete unverified live strategies only when tracked provider state is empty", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({}) as never, createLiveStrategy() as never, {
            allowUnverifiedEmptyProviderState: true,
        }))
            .resolves
            .toBeUndefined()
    })

    it("does not allow force reset to delete unverified live strategies with tracked provider exposure", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_positions: [{
                _id: "position-1",
            }],
        }) as never, createLiveStrategy() as never, {
            allowUnverifiedEmptyProviderState: true,
        }))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("allows force reset to delete stale provider rows only after external flat verification", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_positions: [{
                _id: "position-1",
            }],
        }) as never, createLiveStrategy() as never, {
            allowVerifiedFlatProviderState: true,
        }))
            .resolves
            .toBeUndefined()
    })

    it("does not allow external flat verification to bypass pending order lifecycle state", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            orders: [{
                _id: "order-1",
            }],
        }) as never, createLiveStrategy() as never, {
            allowVerifiedFlatProviderState: true,
        }))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("fails closed when deleting a live strategy with missing provider verification timestamp", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_sync_state: [{
                providerStatus: "healthy",
                driftDetected: false,
            }],
        }) as never, createLiveStrategy() as never))
            .rejects
            .toThrow("provider ownership has not been recently verified")
    })

    it("allows deleting a live strategy only after recent healthy provider verification and no exposure", async () => {
        await expect(assertStrategyDeletionSafe(createDeletionSafetyCtx({
            provider_sync_state: [{
                providerStatus: "healthy",
                driftDetected: false,
                lastVerifiedAt: Date.now(),
            }],
        }) as never, createLiveStrategy() as never))
            .resolves
            .toBeUndefined()
    })

    it("refuses operator reconciliation when broker evidence does not match Convex exposure", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            provider_positions: [{
                _id: "provider-position-live",
                app: "mt5",
                accountId: "account-mt5",
                instrument: "US30",
                positionKey: "US30:provider-position-live",
            }],
            provider_working_orders: [],
            provider_position_history: [],
            provider_sync_state: [],
            alerts: [],
        })

        await expect(callRegistered(operatorReconcileVerifiedFlatProviderState, { db } as never, {
            serviceToken: "test-token",
            app: "mt5",
            accountId: "account-mt5",
            evidence: {
                livePositionCount: 0,
                liveWorkingOrderCount: 0,
                closureLookbackHours: 168,
                note: "worker verified flat",
            },
        }))
            .rejects
            .toThrow("Cannot operator-reconcile mt5:account-mt5 provider positions while Convex has 1 provider position(s) and broker evidence has 0")
    })

    it("preserves retained disappeared history after matching operator evidence", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeMutationDb({
            provider_positions: [{
                _id: "provider-position-live",
                app: "mt5",
                accountId: "account-mt5",
                instrument: "EURUSD",
                positionKey: "EURUSD:provider-position-live",
            }],
            provider_working_orders: [{
                _id: "provider-working-order-1",
                app: "mt5",
                accountId: "account-mt5",
            }],
            provider_position_history: [{
                _id: "provider-history-1",
                app: "mt5",
                accountId: "account-mt5",
                positionKey: "US30:provider-position-1",
                providerPositionId: "provider-position-1",
                retainedUntil: Date.now() + 86_400_000,
            }],
            provider_sync_state: [{
                _id: "sync-1",
                app: "mt5",
                accountId: "account-mt5",
                accountScope: "account",
                providerStatus: "degraded",
                stale: false,
                driftDetected: true,
                lastDriftSummary: "1 owned position disappeared without matching broker close evidence",
                positionCount: 0,
                pendingOrderCount: 0,
                updatedAt: 1,
            }],
            alerts: [],
        })

        const result = await callRegistered(operatorReconcileVerifiedFlatProviderState, { db } as never, {
            serviceToken: "test-token",
            app: "mt5",
            accountId: "account-mt5",
            evidence: {
                livePositionCount: 1,
                liveWorkingOrderCount: 1,
                closureLookbackHours: 168,
                note: "worker verified provider state",
            },
        })

        expect(result).toMatchObject({
            deletedProviderPositionHistory: 0,
            preservedProviderPositionHistory: 1,
            positionCount: 1,
            pendingOrderCount: 1,
            providerStatus: "healthy",
            driftDetected: false,
        })
        expect(db.rows.provider_position_history).toHaveLength(1)
        expect(db.rows.provider_position_history?.[0]).toMatchObject({
            operatorReconciliationEvidence: "worker verified provider state",
        })
        expect(db.rows.provider_position_history?.[0]?.retainedUntil).toBeLessThanOrEqual(Date.now())
        expect(db.rows.provider_sync_state?.[0]).toMatchObject({
            providerStatus: "healthy",
            stale: false,
            driftDetected: false,
            lastError: undefined,
            lastDriftSummary: undefined,
            positionCount: 1,
            pendingOrderCount: 1,
        })
        expect(db.rows.alerts?.[0]?.message).toContain("operator reconciled verified provider state")
    })

    it("keeps MT5 provider reconciliation below the Convex document read limit at production table scale", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const now = Date.now()
        const oldUpdatedAt = now - 60 * 24 * 60 * 60 * 1000
        const accountId = "account-mt5-prod"
        const strategyIds = Array.from({ length: 7 }, (_, index) => `strategy-mt5-${index}`)
        const strategies = strategyIds.map((strategyId, index) => ({
            _id: strategyId,
            app: "mt5",
            accountId,
            name: `MT5 Production ${index + 1}`,
            enabled: true,
            schedule: "*/5 * * * *",
            policy: { dryRun: false },
            context: "",
            createdAt: oldUpdatedAt,
            updatedAt: oldUpdatedAt,
        }))
        const db = new FakeMutationDb({
            strategies,
            strategy_runs: strategyIds.map((strategyId, index) => ({
                _id: `run-${strategyId}`,
                strategyId,
                app: "mt5",
                accountId,
                status: "completed",
                startedAt: oldUpdatedAt + index,
                endedAt: oldUpdatedAt + index + 1_000,
            })),
            instrument_claims: [],
            orders: Array.from({ length: 700 }, (_, index) => createHistoricMT5Order({
                index,
                strategyId: strategyIds[index % strategyIds.length]!,
                accountId,
                updatedAt: oldUpdatedAt - index * 1_000,
            })),
            provider_positions: [{
                _id: "provider-position-closed",
                app: "mt5",
                accountId,
                positionKey: "XAUUSD:1600791765",
                providerPositionId: "1600791765",
                strategyId: strategyIds[0],
                ownershipStatus: "owned",
                expectedExternal: false,
                instrument: "XAUUSD",
                side: "long",
                quantity: 0.02,
                entryPrice: 3340,
                currentPrice: 3350,
                unrealizedPnl: 0,
                metadata: JSON.stringify({ ticket: 1600791765 }),
                syncedAt: oldUpdatedAt,
            }],
            provider_working_orders: [],
            provider_position_history: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: Array.from({ length: 1_300 }, (_, index) =>
                index < 10
                    ? createOpenDisappearedPositionFault({
                        index,
                        strategyId: strategyIds[index % strategyIds.length]!,
                        accountId,
                        occurredAt: oldUpdatedAt + index,
                    })
                    : createResolvedMoneyAuditFault({
                        index,
                        strategyId: strategyIds[index % strategyIds.length]!,
                        accountId,
                        occurredAt: oldUpdatedAt - index,
                    })
            ),
            account_snapshots: [{
                _id: "snapshot-mt5-prod-baseline",
                app: "mt5",
                accountId,
                venue: "mt5",
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
                timestamp: oldUpdatedAt,
            }],
            account_pnl_events: [],
            order_identity_aliases: [],
            control_plane_metrics: [],
            alerts: [],
        })

        await callRegistered(reconcileProviderPortfolio, { db } as never, {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [{
                instrument: "EURUSD",
                providerPositionId: "1700000001",
                side: "long",
                quantity: 0.01,
                entryPrice: 1.1,
                currentPrice: 1.1,
                unrealizedPnl: 0,
                metadata: JSON.stringify({ ticket: 1700000001 }),
            }],
            workingOrders: [],
            positionClosures: [{
                instrument: "XAUUSD",
                providerPositionId: "1600791765",
                side: "long",
                quantity: 0.02,
                fillPrice: 3355,
                closedAt: now - 30_000,
                metadata: JSON.stringify({
                    ticket: 900001,
                    orderId: 1700000999,
                    positionId: 1600791765,
                    fillPnl: 30,
                    profit: 30,
                    commission: -1,
                    swap: 0,
                }),
            }],
            accountPnlEvents: [],
        })

        expect(db.documentsRead).toBeLessThan(3_000)
    })

    it("keeps immediate repeated MT5 reconciliation below 300 reads after repair watermarks advance", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const now = Date.now()
        const recentUpdatedAt = now - 20 * 60 * 1000
        const accountId = "account-mt5-watermark"
        const strategyIds = Array.from({ length: 7 }, (_, index) => `strategy-watermark-${index}`)
        const strategies = strategyIds.map((strategyId, index) => ({
            _id: strategyId,
            app: "mt5",
            accountId,
            name: `MT5 Watermark ${index + 1}`,
            enabled: true,
            schedule: "*/5 * * * *",
            policy: { dryRun: false },
            context: "",
            createdAt: recentUpdatedAt,
            updatedAt: recentUpdatedAt,
        }))
        const db = new FakeMutationDb({
            strategies,
            strategy_runs: strategyIds.map((strategyId, index) => ({
                _id: `run-${strategyId}`,
                strategyId,
                app: "mt5",
                accountId,
                status: "completed",
                startedAt: recentUpdatedAt + index,
                endedAt: recentUpdatedAt + index + 1_000,
            })),
            instrument_claims: [],
            orders: Array.from({ length: 700 }, (_, index) => createRecentFilledMT5Order({
                index,
                strategyId: strategyIds[index % strategyIds.length]!,
                accountId,
                updatedAt: recentUpdatedAt - index,
            })),
            provider_positions: [],
            provider_working_orders: [],
            provider_position_history: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [{
                _id: "snapshot-mt5-watermark-baseline",
                app: "mt5",
                accountId,
                venue: "mt5",
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
                timestamp: recentUpdatedAt - 1_000,
            }],
            account_pnl_events: [],
            order_identity_aliases: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const reconcileArgs = {
            serviceToken: "test-token",
            app: "mt5",
            accountId,
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [{
                instrument: "EURUSD",
                providerPositionId: "watermark-live-position",
                side: "long",
                quantity: 0.01,
                entryPrice: 1.1,
                currentPrice: 1.1,
                unrealizedPnl: 0,
            }],
            workingOrders: [],
            positionClosures: [],
            accountPnlEvents: [],
        }

        await callRegistered(reconcileProviderPortfolio, { db } as never, reconcileArgs)
        const firstReadCount = db.documentsRead
        db.documentsRead = 0

        await callRegistered(reconcileProviderPortfolio, { db } as never, reconcileArgs)
        const secondReadCount = db.documentsRead

        expect(firstReadCount).toBeGreaterThan(1_000)
        expect(secondReadCount).toBeLessThan(300)
        expect(db.rows.provider_sync_state?.[0]).toMatchObject({
            lastFilledOrderRepairScanAt: expect.any(Number),
            lastKnownProviderCloseScanAt: expect.any(Number),
        })
    })

    it("records one account-level money audit fault and applies it to strategy risk", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const accountId = "account-alpaca-options-prod"
        const previousSnapshotAt = Date.parse("2026-07-07T13:30:00.000Z")
        const strategyIds = ["strategy-alpaca-1", "strategy-alpaca-2", "strategy-alpaca-3"]
        const targetStrategyId = strategyIds[0]!
        const strategies = strategyIds.map((strategyId, index) => ({
            _id: strategyId,
            app: "alpaca-options",
            accountId,
            name: `Alpaca Options ${index + 1}`,
            enabled: index !== 2,
            schedule: "*/5 * * * *",
            policy: { dryRun: false },
            context: "",
            createdAt: previousSnapshotAt,
            updatedAt: previousSnapshotAt,
        }))
        const db = new FakeMutationDb({
            strategies,
            orders: [],
            instrument_claims: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_position_history: [],
            provider_sync_state: [],
            account_snapshots: [{
                _id: "snapshot-alpaca-baseline",
                app: "alpaca-options",
                accountId,
                venue: "alpaca-options",
                balance: 10_000,
                equity: 10_000,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 0,
                dayPnl: 0,
                timestamp: previousSnapshotAt,
            }],
            account_pnl_events: [],
            execution_safety_faults: [],
            strategy_risk_states: [],
            control_plane_metrics: [],
            alerts: [],
        })

        await callRegistered(reconcileProviderPortfolio, { db } as never, {
            serviceToken: "test-token",
            app: "alpaca-options",
            accountId,
            venue: "alpaca-options",
            source: "periodic_sync",
            accountState: {
                balance: 10_000,
                equity: 9_969,
                buyingPower: 10_000,
                marginUsed: 0,
                marginAvailable: 10_000,
                openPnl: 19,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [],
            accountPnlEvents: [],
        })

        const faults = db.rows.execution_safety_faults ?? []
        expect(faults).toHaveLength(1)
        expect(faults[0]).toMatchObject({
            strategyId: undefined,
            app: "alpaca-options",
            accountId,
            instrument: "account",
            category: "accounting_mismatch",
            blocked: true,
        })
        expect(faults[0]?.message).toContain("equity delta -31.000000")
        expect(faults[0]?.message).toContain("attributed realized 0.000000")
        expect(faults[0]?.message).toContain("open PnL delta 19.000000")
        expect(faults[0]?.message).toContain("residual -50.000000")

        const result = await callRegistered(refreshStrategyRiskState, { db } as never, {
            serviceToken: "test-token",
            strategyId: targetStrategyId,
            app: "alpaca-options",
            policy: {
                maxDrawdownDay: 100,
                maxDrawdownWeek: 200,
                cooldownMinutesAfterDayBreach: 60,
                cooldownMinutesAfterWeekBreach: 120,
                strategyTimezone: "UTC",
            },
        })

        expect(result).toMatchObject({
            safetyState: "execution_degraded",
            blockedInstruments: ["account"],
            unresolvedExecutionFaultCount: 1,
        })
        expect(db.rows.strategy_risk_states).toContainEqual(expect.objectContaining({
            strategyId: targetStrategyId,
            safetyState: "execution_degraded",
            blockedInstruments: ["account"],
            unresolvedExecutionFaultCount: 1,
        }))
    })

    it("scopes batched last-strategy cleanup to the strategy account and keeps account snapshots", async () => {
        const db = new FakeMutationDb({
            strategies: [{
                _id: "strategy-live",
                app: "mt5",
                accountId: "acct-1",
            }],
            account_snapshots: [{
                _id: "snapshot-1",
                app: "mt5",
                accountId: "acct-1",
            }],
            provider_sync_state: [{
                _id: "sync-1",
                app: "mt5",
                accountId: "acct-1",
            }],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "mt5",
            }],
        })
        const deleted = createEmptyCascadeDeleteCounts()
        const ctx = { db }

        await expect(deleteStrategyTableBatch(ctx as never, "strategy-live" as never, "mt5" as never, deleted, 50))
            .resolves
            .toBe(false)

        expect(deleted.accountSnapshots).toBe(0)
        expect(deleted.providerSyncStates).toBe(0)
        expect(deleted.appHeartbeats).toBe(0)
        expect(db.rows.account_snapshots).toHaveLength(1)
        expect(db.rows.provider_sync_state).toHaveLength(1)
        expect(db.rows.app_heartbeats).toHaveLength(1)

        await deleteFinalStrategyAccountRows(ctx as never, {
            _id: "strategy-live",
            app: "mt5",
            accountId: "acct-1",
        } as never, deleted)

        expect(deleted.providerSyncStates).toBe(1)
        expect(db.rows.provider_sync_state).toHaveLength(0)

        await deleteFinalStrategyAppRows(ctx as never, "mt5" as never, deleted)

        expect(deleted.appHeartbeats).toBe(1)
        expect(db.rows.account_snapshots).toHaveLength(1)
        expect(db.rows.app_heartbeats).toHaveLength(0)
    })

    it("does not touch sibling account rows when deleting the last strategy of one account", async () => {
        const db = new FakeMutationDb({
            strategies: [
                {
                    _id: "strategy-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "strategy-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            provider_positions: [
                {
                    _id: "pos-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "pos-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            provider_working_orders: [
                {
                    _id: "wo-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "wo-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            provider_sync_state: [
                {
                    _id: "sync-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "sync-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            account_snapshots: [
                {
                    _id: "snap-a",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "snap-b",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        })
        const ctx = { db }

        const counts = await cascadeDeleteStrategy(ctx as never, "strategy-a" as never)

        expect(counts.providerPositions).toBe(1)
        expect(counts.providerWorkingOrders).toBe(1)
        expect(counts.providerSyncStates).toBe(1)
        expect(counts.accountSnapshots).toBe(0)
        expect(counts.appHeartbeats).toBe(0)
        expect(db.rows.provider_positions?.map((row) => row._id)).toEqual(["pos-b"])
        expect(db.rows.provider_working_orders?.map((row) => row._id)).toEqual(["wo-b"])
        expect(db.rows.provider_sync_state?.map((row) => row._id)).toEqual(["sync-b"])
        expect(db.rows.account_snapshots?.map((row) => row._id)).toEqual(["snap-a", "snap-b"])
        expect(db.rows.app_heartbeats).toHaveLength(1)
        expect(db.rows.strategies?.map((row) => row._id)).toEqual(["strategy-b"])
    })

    it("keeps account snapshots and pnl events when deleting the last strategy for an app", async () => {
        const db = new FakeMutationDb({
            strategies: [{
                _id: "strategy-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            provider_sync_state: [{
                _id: "sync-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            account_snapshots: [{
                _id: "snap-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            account_pnl_events: [{
                _id: "pnl-a",
                app: "okx-swap",
                accountId: "acct-a",
            }],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        })
        const ctx = { db }

        const counts = await cascadeDeleteStrategy(ctx as never, "strategy-a" as never)

        expect(counts.providerSyncStates).toBe(1)
        expect(counts.accountSnapshots).toBe(0)
        expect(counts.appHeartbeats).toBe(1)
        expect(db.rows.account_snapshots).toHaveLength(1)
        expect(db.rows.account_pnl_events).toHaveLength(1)
        expect(db.rows.provider_sync_state).toHaveLength(0)
        expect(db.rows.app_heartbeats).toHaveLength(0)
    })

    it("keeps app heartbeats while sibling strategies remain", async () => {
        const db = new FakeMutationDb({
            strategies: [
                {
                    _id: "strategy-live",
                    app: "okx-swap",
                    accountId: "acct-a",
                },
                {
                    _id: "strategy-sibling",
                    app: "okx-swap",
                    accountId: "acct-b",
                },
            ],
            app_heartbeats: [{
                _id: "heartbeat-1",
                app: "okx-swap",
            }],
        })
        const deleted = createEmptyCascadeDeleteCounts()

        await deleteFinalStrategyAppRows({ db } as never, "okx-swap" as never, deleted)

        expect(deleted.appHeartbeats).toBe(0)
        expect(db.rows.app_heartbeats).toHaveLength(1)
    })

    it("keeps provider identity and protection levels in strategy position snapshot hashes", () => {
        const payload = buildStrategyPositionSnapshotHashPayload([
            {
                instrument: "XAUUSD",
                positionKey: "XAUUSD:1600791765",
                providerPositionId: "1600791765",
                side: "long",
                quantity: 0.02,
                entryPrice: 3350,
                currentPrice: 3362,
                unrealizedPnl: 24,
                stopLoss: 3290,
                takeProfit: 3450,
                metadata: JSON.stringify({ ticket: 1600791765 }),
            },
            {
                instrument: "XAUUSD",
                positionKey: "XAUUSD:1600791764",
                providerPositionId: "1600791764",
                side: "long",
                quantity: 0.01,
                entryPrice: 3340,
                currentPrice: 3362,
                unrealizedPnl: 22,
                stopLoss: 3300,
                takeProfit: 3425,
                metadata: JSON.stringify({ ticket: 1600791764 }),
            },
        ])

        expect(payload).toEqual([
            expect.objectContaining({
                positionKey: "XAUUSD:1600791764",
                providerPositionId: "1600791764",
                stopLoss: 3300,
                takeProfit: 3425,
            }),
            expect.objectContaining({
                positionKey: "XAUUSD:1600791765",
                providerPositionId: "1600791765",
                stopLoss: 3290,
                takeProfit: 3450,
            }),
        ])
    })
})

const HISTORIC_MT5_ORDER_STATUSES = [
    "pending",
    "filled",
    "partially_filled",
    "cancelled",
    "rejected",
    "expired",
    "timed_out",
] as const

function createHistoricMT5Order(args: {
    index: number
    strategyId: string
    accountId: string
    updatedAt: number
}) {
    const status = HISTORIC_MT5_ORDER_STATUSES[args.index % HISTORIC_MT5_ORDER_STATUSES.length]!
    const ticket = 15_000_000 + args.index
    const filledQuantity = status === "filled" || status === "partially_filled"
        ? 0.01
        : 0
    const remainingQuantity = status === "partially_filled"
        ? 0.01
        : status === "filled"
            ? 0
            : 0.02

    return {
        _id: `historic-order-${args.index}`,
        orderId: String(ticket),
        canonicalOrderId: String(ticket),
        providerOrderId: String(ticket),
        providerClientOrderId: `historic-client-${args.index}`,
        providerOrderAliases: [String(ticket)],
        runId: `run-${args.strategyId}`,
        strategyId: args.strategyId,
        app: "mt5",
        accountId: args.accountId,
        venue: "mt5",
        instrument: args.index % 2 === 0 ? "XAUUSD" : "EURUSD",
        status,
        action: args.index % 5 === 0 ? "close" : "entry",
        quantity: 0.02,
        filledQuantity,
        remainingQuantity,
        avgFillPrice: filledQuantity > 0 ? 3340 + args.index / 100 : undefined,
        submittedAt: args.updatedAt - 10_000,
        updatedAt: args.updatedAt,
        intent: {
            instrument: args.index % 2 === 0 ? "XAUUSD" : "EURUSD",
            metadata: {
                ticket,
                orderId: ticket,
                positionId: ticket,
                providerPositionId: String(ticket),
                providerPositionKey: `${args.index % 2 === 0 ? "XAUUSD" : "EURUSD"}:${ticket}`,
                estimatedPrice: 3340 + args.index / 100,
            },
            side: args.index % 2 === 0 ? "buy" : "sell",
            quantity: 0.02,
            orderType: "market",
        },
        lastTransitionSequence: 1,
        polling: {
            pollIntervalMs: 0,
            timeoutMs: 0,
            startedAt: args.updatedAt - 10_000,
            lastCheckedAt: args.updatedAt,
        },
    }
}

function createRecentFilledMT5Order(args: {
    index: number
    strategyId: string
    accountId: string
    updatedAt: number
}) {
    const ticket = 25_000_000 + args.index

    return {
        _id: `recent-filled-order-${args.index}`,
        orderId: String(ticket),
        canonicalOrderId: String(ticket),
        providerOrderId: String(ticket),
        providerClientOrderId: `recent-filled-client-${args.index}`,
        providerOrderAliases: [String(ticket)],
        runId: `run-${args.strategyId}`,
        strategyId: args.strategyId,
        app: "mt5",
        accountId: args.accountId,
        venue: "mt5",
        instrument: "GBPUSD",
        status: "filled",
        action: "entry",
        quantity: 0.02,
        filledQuantity: 0.02,
        remainingQuantity: 0,
        avgFillPrice: 1.25 + args.index / 100_000,
        submittedAt: args.updatedAt - 10_000,
        updatedAt: args.updatedAt,
        intent: {
            instrument: "GBPUSD",
            metadata: {
                ticket,
                orderId: ticket,
                positionId: ticket,
                providerPositionId: String(ticket),
                providerPositionKey: `GBPUSD:${ticket}`,
                estimatedPrice: 1.25 + args.index / 100_000,
            },
            side: "buy",
            quantity: 0.02,
            orderType: "market",
        },
        lastTransitionSequence: 1,
        polling: {
            pollIntervalMs: 0,
            timeoutMs: 0,
            startedAt: args.updatedAt - 10_000,
            lastCheckedAt: args.updatedAt,
        },
    }
}

function createResolvedMoneyAuditFault(args: {
    index: number
    strategyId: string
    accountId: string
    occurredAt: number
}) {
    return {
        _id: `resolved-money-fault-${args.index}`,
        strategyId: args.strategyId,
        app: "mt5",
        accountId: args.accountId,
        instrument: "account",
        category: "accounting_mismatch",
        message: `Money-level reconciliation mismatch: production audit residual ${args.index}`,
        providerPayload: JSON.stringify({
            equityDelta: 0,
            attributedOrderPnl: 0,
            residual: 0.01,
            source: "money_audit",
        }),
        blocked: false,
        occurredAt: args.occurredAt,
        resolvedAt: args.occurredAt + 1_000,
        resolutionNote: "Provider money-level reconciliation audit passed within tolerance",
    }
}

function createOpenDisappearedPositionFault(args: {
    index: number
    strategyId: string
    accountId: string
    occurredAt: number
}) {
    const providerPositionId = String(16_000_000 + args.index)
    const instrument = args.index % 2 === 0 ? "US30" : "XAGUSD"
    const side = args.index % 2 === 0 ? "long" : "short"

    return {
        _id: `open-disappeared-position-fault-${args.index}`,
        strategyId: args.strategyId,
        app: "mt5",
        accountId: args.accountId,
        instrument,
        category: "accounting_mismatch",
        message: `${instrument} ${side} disappeared from provider without close evidence`,
        providerPayload: JSON.stringify({
            instrument,
            side,
            quantity: 0.01,
            entryPrice: 3350 + args.index,
            providerPositionId,
            positionKey: `${instrument}:${providerPositionId}`,
        }),
        blocked: true,
        occurredAt: args.occurredAt,
        resolvedAt: undefined,
        resolutionNote: undefined,
    }
}
