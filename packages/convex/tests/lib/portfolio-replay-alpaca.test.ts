import { describe, expect, it } from "vitest"
import { resolveAlpacaCloseGroupsFromPositions } from "@valiq-trading/alpaca-options"
import { getClaimInstrumentsForOrder } from "../../convex/lib/instrumentClaims"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { resolveExecutionSafetyFaultsFromProviderTruth } from "../../convex/lib/mutations/portfolioRows"
import { getPortfolioPositions } from "../../convex/lib/queries/portfolio"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex Alpaca SPY replay", () => {
    it("keeps separate call and put vertical strategies isolated through provider reconciliation", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const callStrategy = "strategy-call-vertical"
        const putStrategy = "strategy-put-vertical"
        const callVertical = "VS:BEAR_CALL_CREDIT:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000"
        const putVertical = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"
        const db = new FakeDb({
            strategies: [
                {
                    _id: callStrategy,
                    app: "alpaca-options",
                    name: "SPY call vertical",
                    policy: { dryRun: false },
                },
                {
                    _id: putStrategy,
                    app: "alpaca-options",
                    name: "SPY put vertical",
                    policy: { dryRun: false },
                },
            ],
            instrument_claims: [
                ...buildClaims(callStrategy, callVertical, [
                    { instrument: "SPY260501C00720000", side: "sell_to_open" },
                    { instrument: "SPY260501C00721000", side: "buy_to_open" },
                ]),
                ...buildClaims(putStrategy, putVertical, [
                    { instrument: "SPY260501P00694000", side: "buy_to_open" },
                    { instrument: "SPY260501P00695000", side: "sell_to_open" },
                ]),
            ],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
            venue: "alpaca",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [
                createProviderLeg("SPY260501C00720000", "short", 0.3),
                createProviderLeg("SPY260501C00721000", "long", 0.12),
                createProviderLeg("SPY260501P00694000", "long", 0.19),
                createProviderLeg("SPY260501P00695000", "short", 0.44),
            ],
            workingOrders: [],
        })

        const providerPositions = db.rows.provider_positions ?? []
        expect(providerPositions).toHaveLength(4)
        expect(providerPositions.find((row) => row.instrument === "SPY260501C00720000")?.strategyId).toBe(callStrategy)
        expect(providerPositions.find((row) => row.instrument === "SPY260501C00721000")?.strategyId).toBe(callStrategy)
        expect(providerPositions.find((row) => row.instrument === "SPY260501P00694000")?.strategyId).toBe(putStrategy)
        expect(providerPositions.find((row) => row.instrument === "SPY260501P00695000")?.strategyId).toBe(putStrategy)
        expect(providerPositions.some((row) => String(row.instrument).startsWith("IC:"))).toBe(false)
        expect(providerPositions.some((row) => row.ownershipStatus !== "owned")).toBe(false)
        expect(readMetadata(providerPositions.find((row) => row.instrument === "SPY260501C00720000")?.metadata)).toMatchObject({
            alpacaClaimInstrument: callVertical,
        })
        expect(readMetadata(providerPositions.find((row) => row.instrument === "SPY260501P00695000")?.metadata)).toMatchObject({
            alpacaClaimInstrument: putVertical,
        })

        const rows = await callRegistered(getPortfolioPositions, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
        }) as Array<{ strategyName?: string; instrument: string; side: "long" | "short"; quantity: number; entryPrice: number; metadata?: Record<string, unknown> }>
        expect(rows).toHaveLength(4)
        expect(rows.map((row: { strategyName?: string }) => row.strategyName).sort()).toEqual([
            "SPY call vertical",
            "SPY call vertical",
            "SPY put vertical",
            "SPY put vertical",
        ])
        expect(rows.find((row) => row.instrument === "SPY260501C00720000")?.metadata).toMatchObject({
            alpacaClaimInstrument: callVertical,
        })
        expect(rows.find((row) => row.instrument === "SPY260501P00695000")?.metadata).toMatchObject({
            alpacaClaimInstrument: putVertical,
        })

        const grouped = resolveAlpacaCloseGroupsFromPositions(rows)
        expect(grouped.map((position) => position.instrument).sort()).toEqual([
            callVertical,
            putVertical,
        ])
    })

    it("does not create executable Alpaca close metadata from unclaimed raw-leg geometry", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-unclaimed"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "alpaca-options",
                name: "Unclaimed SPY legs",
                policy: { dryRun: false },
            }],
            instrument_claims: [],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
            venue: "alpaca",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [
                createProviderLeg("SPY260501P00694000", "long", 0.19),
                createProviderLeg("SPY260501P00695000", "short", 0.44),
            ],
            workingOrders: [],
        })

        const rows = await callRegistered(getPortfolioPositions, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
        }) as Array<{ instrument: string; metadata?: Record<string, unknown> }>
        expect(rows).toHaveLength(2)
        expect(rows.some((row) => row.metadata?.alpacaClaimInstrument)).toBe(false)

        const grouped = resolveAlpacaCloseGroupsFromPositions(rows as Array<{
            instrument: string
            side: "long" | "short"
            quantity: number
            entryPrice: number
            metadata?: Record<string, unknown>
        }>)
        expect(grouped.map((position) => position.instrument).sort()).toEqual([
            "SPY260501P00694000",
            "SPY260501P00695000",
        ])
    })

    it("emits a blocked duplicate_exposure fault for provider-proven overlap", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-overlap"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                name: "Overlap strategy",
                policy: {
                    dryRun: false,
                    allowOverlappingExposure: false,
                    allowMultiplePendingEntryOrdersPerInstrument: false,
                },
            }],
            instrument_claims: [{
                _id: "claim-xauusd",
                strategyId,
                app: "mt5",
                instrument: "XAUUSD",
                source: "position",
                sourceId: "XAUUSD",
                updatedAt: Date.now(),
            }],
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never
        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "mt5",
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [{
                instrument: "XAUUSD",
                side: "short",
                quantity: 0.01,
                entryPrice: 3200,
            }],
            workingOrders: [{
                orderId: "1607001000",
                instrument: "XAUUSD",
                status: "pending",
                action: "entry",
                side: "sell",
                quantity: 0.01,
                filledQuantity: 0,
                remainingQuantity: 0.01,
                submittedAt: Date.now(),
                updatedAt: Date.now(),
            }],
        })

        expect(db.rows.execution_safety_faults).toEqual([
            expect.objectContaining({
                strategyId,
                app: "mt5",
                instrument: "XAUUSD",
                category: "duplicate_exposure",
                blocked: true,
            }),
        ])
        expect(db.rows.alerts?.some((alert) =>
            String(alert.message).includes("duplicate_exposure")
        )).toBe(true)
    })

    it("records a blocking accounting fault when an owned Alpaca position vanishes without close evidence", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-vanish"
        const accountId = "alpaca-acct-a"
        const vertical = "VS:BEAR_CALL_CREDIT:SPY:2026-05-01:SPY260501C00720000|SPY260501C00721000"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "alpaca-options",
                accountId,
                name: "SPY call vertical",
                policy: { dryRun: false },
            }],
            instrument_claims: [],
            orders: [],
            provider_positions: [{
                _id: "provider-position-vanish",
                app: "alpaca-options",
                accountId,
                positionKey: `alpaca-options:${vertical}:short`,
                strategyId,
                ownershipStatus: "owned",
                instrument: vertical,
                side: "short",
                quantity: 1,
                entryPrice: 0.45,
                syncedAt: Date.now() - 60_000,
            }],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
            accountId,
            venue: "alpaca",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
        })

        expect(db.rows.execution_safety_faults).toEqual([
            expect.objectContaining({
                strategyId,
                app: "alpaca-options",
                instrument: vertical,
                category: "accounting_mismatch",
                blocked: true,
            }),
        ])
        const syncState = (db.rows.provider_sync_state ?? [])[0]
        expect(syncState?.driftDetected).toBe(true)
    })

    it("imports Alpaca option expiry activity as provider close evidence for a vanished owned leg", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-expiry"
        const runId = "run-expiry"
        const accountId = "alpaca-acct-a"
        const instrument = "SPY260501C00720000"
        const closedAt = Date.parse("2026-05-01T23:59:59.999Z")
        const lastLiveSyncAt = Date.parse("2026-05-01T20:00:00.000Z")
        const openedAt = Date.parse("2026-05-01T14:30:00.000Z")
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "alpaca-options",
                accountId,
                name: "SPY short call",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "alpaca-options",
                accountId,
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [],
            provider_positions: [{
                _id: "provider-position-expiry",
                app: "alpaca-options",
                accountId,
                positionKey: `${instrument}:${instrument}`,
                providerPositionId: instrument,
                strategyId,
                ownershipStatus: "owned",
                instrument,
                side: "short",
                quantity: 2,
                entryPrice: 1.25,
                syncedAt: lastLiveSyncAt,
            }],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
            accountId,
            venue: "alpaca",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument,
                providerPositionId: instrument,
                side: "short",
                quantity: 2,
                fillPrice: 0,
                closedAt,
                metadata: JSON.stringify({
                    providerAccountingSource: "alpaca_account_activity",
                    providerActivityId: "activity-expiry-1",
                    activityType: "OPEXP",
                    fillPnl: 0,
                    netAmount: 0,
                    providerPositionId: instrument,
                }),
            }],
        })

        expect(db.rows.execution_safety_faults).toEqual([])
        const closeOrder = (db.rows.orders ?? []).find((order) => order.action === "close")
        expect(closeOrder).toMatchObject({
            orderId: `provider-close:alpaca-options:${instrument}:${instrument}:${closedAt}`,
            runId,
            strategyId,
            instrument,
            status: "filled",
            action: "close",
            quantity: 2,
            filledQuantity: 2,
            avgFillPrice: 0,
        })
        if (!closeOrder) {
            throw new Error("Expected Alpaca provider-close order")
        }
        expect(((closeOrder?.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            providerReconciledClose: true,
            providerAccountingSource: "alpaca_account_activity",
            providerActivityId: "activity-expiry-1",
            activityType: "OPEXP",
            providerPositionId: instrument,
            positionSide: "short",
            entryPrice: 1.25,
        })
    })

    it("records a blocking fault when provider closure evidence marks accounting missing", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-closure-missing"
        const runId = "run-closure-missing"
        const accountId = "alpaca-acct-a"
        const instrument = "SPY260501C00720000"
        const closedAt = Date.parse("2026-05-01T00:00:00.000Z")
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "alpaca-options",
                accountId,
                name: "SPY short call",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "alpaca-options",
                accountId,
                status: "completed",
                startedAt: closedAt - 60_000,
                endedAt: closedAt - 30_000,
            }],
            instrument_claims: [],
            orders: [],
            provider_positions: [{
                _id: "provider-position-closure-missing",
                app: "alpaca-options",
                accountId,
                positionKey: `${instrument}:${instrument}`,
                providerPositionId: instrument,
                strategyId,
                ownershipStatus: "owned",
                instrument,
                side: "short",
                quantity: 1,
                entryPrice: 1.25,
                syncedAt: closedAt - 60_000,
            }],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
            accountId,
            venue: "alpaca",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument,
                providerPositionId: instrument,
                side: "short",
                quantity: 1,
                fillPrice: 0,
                closedAt,
                metadata: JSON.stringify({
                    providerAccountingSource: "alpaca_account_activity",
                    providerAccountingMissing: true,
                    providerAccountingMissingReason: "alpaca_closure_without_fee_activity",
                    providerPositionId: instrument,
                }),
            }],
        })

        expect((db.rows.orders ?? []).some((order) => order.action === "close")).toBe(true)
        expect(db.rows.execution_safety_faults).toEqual([
            expect.objectContaining({
                strategyId,
                app: "alpaca-options",
                instrument,
                category: "accounting_mismatch",
                canonicalOrderId: `provider-close:alpaca-options:${instrument}:${instrument}:${closedAt}`,
                blocked: true,
            }),
        ])
    })

    it("keeps or clears duplicate-exposure faults from provider-truth residual exposure", async () => {
        const strategyId = "strategy-overlap"
        const updatedAt = Date.now()
        const fault = {
            _id: "fault-overlap",
            strategyId,
            app: "mt5",
            instrument: "XAUUSD",
            category: "duplicate_exposure",
            canonicalOrderId: "vmtc01abcde23456",
            providerClientOrderId: "vmtc01abcde23456",
            providerOrderAliases: [],
            message: "Provider reconciliation proved duplicate exposure: overlap on XAUUSD",
            blocked: true,
            occurredAt: updatedAt,
            resolvedAt: undefined,
            resolutionNote: undefined,
        }
        const matchingWorkingOrder = {
            orderId: "1607003000",
            providerOrderId: "1607003000",
            providerClientOrderId: "vmtc01abcde23456",
            providerOrderAliases: [],
            signedOrderFingerprint: undefined,
            instrument: "XAUUSD",
            ownershipStatus: "owned",
        }
        const createDb = (orders: Row[] = []) => new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                name: "Overlap strategy",
                policy: {
                    dryRun: false,
                },
            }],
            orders,
            execution_safety_faults: [fault],
            alerts: [],
        })
        const cases = [
            {
                name: "recovered order doc while owned exposure remains",
                orders: [{
                    _id: "order-recovered",
                    strategyId,
                    app: "mt5",
                    orderId: "vmtc01abcde23456",
                    providerClientOrderId: "vmtc01abcde23456",
                    instrument: "XAUUSD",
                    status: "pending",
                    commitOutcome: "recovered",
                }],
                positions: [{
                    instrument: "XAUUSD",
                    ownershipStatus: "owned",
                }],
                workingOrders: [],
                expectedFault: {
                    _id: "fault-overlap",
                    blocked: true,
                    resolvedAt: undefined,
                    resolutionNote: undefined,
                },
                expectedAlert: undefined,
            },
            {
                name: "matching live order while residual exposure remains",
                orders: [],
                positions: [{
                    instrument: "XAUUSD",
                    ownershipStatus: "owned",
                }],
                workingOrders: [matchingWorkingOrder],
                expectedFault: {
                    _id: "fault-overlap",
                    blocked: true,
                    resolvedAt: undefined,
                    resolutionNote: undefined,
                },
                expectedAlert: undefined,
            },
            {
                name: "one matching live order without residual exposure",
                orders: [],
                positions: [],
                workingOrders: [matchingWorkingOrder],
                expectedFault: {
                    _id: "fault-overlap",
                    blocked: false,
                    resolvedAt: updatedAt,
                    resolutionNote: "Provider reconciliation proved live canonical working order 1607003000",
                },
                expectedAlert: expect.objectContaining({
                    strategyId,
                    severity: "info",
                }),
            },
        ]

        for (const testCase of cases) {
            const db = createDb(testCase.orders)
            const ctx = { db } as never

            await resolveExecutionSafetyFaultsFromProviderTruth(ctx, {
                app: "mt5",
                positions: testCase.positions,
                workingOrders: testCase.workingOrders,
                updatedAt,
            } as never)

            expect(db.rows.execution_safety_faults, testCase.name).toEqual([
                expect.objectContaining(testCase.expectedFault),
            ])
            expect(db.rows.alerts, testCase.name).toEqual(
                testCase.expectedAlert ? [testCase.expectedAlert] : []
            )
        }
    })

    it("does not clear Alpaca structure safety faults while claimed raw legs remain live", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-alpaca-fault"
        const vertical = "VS:BULL_PUT_CREDIT:SPY:2026-05-01:SPY260501P00694000|SPY260501P00695000"
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "alpaca-options",
                name: "Alpaca fault strategy",
                policy: { dryRun: false },
            }],
            instrument_claims: buildClaims(strategyId, vertical, [
                { instrument: "SPY260501P00694000", side: "buy_to_open" },
                { instrument: "SPY260501P00695000", side: "sell_to_open" },
            ]),
            orders: [],
            provider_positions: [],
            provider_working_orders: [],
            provider_sync_state: [],
            position_syncs: [],
            positions: [],
            execution_safety_faults: [{
                _id: "fault-vertical",
                strategyId,
                app: "alpaca-options",
                instrument: vertical,
                category: "duplicate_exposure",
                message: "Provider reconciliation proved duplicate exposure: overlap on SPY vertical",
                blocked: true,
                occurredAt: Date.now(),
                resolvedAt: undefined,
                resolutionNote: undefined,
            }],
            account_snapshots: [],
            control_plane_metrics: [],
            alerts: [],
        })
        const ctx = { db } as never

        await callRegistered(reconcileProviderPortfolio, ctx, {
            serviceToken: "test-token",
            app: "alpaca-options",
            venue: "alpaca",
            source: "periodic_sync",
            accountState: {
                balance: 100000,
                equity: 100000,
                buyingPower: 100000,
                marginUsed: 0,
                marginAvailable: 100000,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [
                createProviderLeg("SPY260501P00694000", "long", 0.19),
                createProviderLeg("SPY260501P00695000", "short", 0.44),
            ],
            workingOrders: [],
        })

        expect(db.rows.execution_safety_faults).toEqual([
            expect.objectContaining({
                _id: "fault-vertical",
                blocked: true,
                resolvedAt: undefined,
                resolutionNote: undefined,
            }),
        ])
    })
})

function buildClaims(
    strategyId: string,
    instrument: string,
    legs: Array<{ instrument: string; side: string }>
): Row[] {
    return getClaimInstrumentsForOrder(instrument, { legs }).map((claimInstrument) => ({
        _id: `${strategyId}:${claimInstrument}`,
        strategyId,
        app: "alpaca-options",
        instrument: claimInstrument,
        source: "position",
        sourceId: claimInstrument,
        updatedAt: Date.now(),
    }))
}

function createProviderLeg(
    instrument: string,
    side: "long" | "short",
    entryPrice: number
) {
    return {
        instrument,
        side,
        quantity: 1,
        entryPrice,
        currentPrice: entryPrice,
    }
}

function readMetadata(metadata: unknown): Record<string, unknown> | undefined {
    if (typeof metadata === "string") {
        return JSON.parse(metadata) as Record<string, unknown>
    }

    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : undefined
}
