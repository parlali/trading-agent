import { describe, expect, it } from "vitest"
import { resolveAlpacaCloseGroupsFromPositions } from "@valiq-trading/alpaca-options"
import { resolveCloseOrderRealizedPnl } from "@valiq-trading/core"
import { getClaimInstrumentsForOrder } from "../../convex/lib/instrumentClaims"
import { reconcileProviderPortfolio } from "../../convex/lib/mutations/portfolio"
import { resolveExecutionSafetyFaultsFromProviderTruth } from "../../convex/lib/mutations/portfolioRows"
import { getPortfolioPositions } from "../../convex/lib/queries/portfolio"

type Row = {
    _id: string
    [key: string]: unknown
}

type RegisteredFunctionForTest = {
    _handler: (ctx: never, args: never) => Promise<unknown>
}

class FakeDb {
    rows: Record<string, Row[]> = {}
    private nextId = 1

    constructor(seed: Record<string, Array<Record<string, unknown>>>) {
        for (const [table, rows] of Object.entries(seed)) {
            this.rows[table] = rows.map((row) => ({
                _id: String(row._id ?? `${table}-${this.nextId++}`),
                ...row,
            }))
        }
    }

    query(table: string) {
        return new FakeQuery(this.rows[table] ?? [])
    }

    async insert(table: string, row: Record<string, unknown>) {
        const inserted = {
            _id: `${table}-${this.nextId++}`,
            _creationTime: Date.now(),
            ...row,
        }
        const rows = this.rows[table] ?? []
        rows.push(inserted)
        this.rows[table] = rows
        return inserted._id
    }

    async patch(id: string, patch: Record<string, unknown>) {
        for (const rows of Object.values(this.rows)) {
            const row = rows.find((entry) => entry._id === id)
            if (row) {
                Object.assign(row, patch)
                return
            }
        }
    }

    async delete(id: string) {
        for (const rows of Object.values(this.rows)) {
            const index = rows.findIndex((entry) => entry._id === id)
            if (index >= 0) {
                rows.splice(index, 1)
                return
            }
        }
    }

    async get(id: string) {
        for (const rows of Object.values(this.rows)) {
            const row = rows.find((entry) => entry._id === id)
            if (row) {
                return row
            }
        }

        return null
    }
}

class FakeQuery {
    private filters: Array<{ field: string; value: unknown }> = []
    private orderDirection: "asc" | "desc" = "asc"

    constructor(
        private readonly rows: Row[]
    ) {}

    withIndex(_name: string, filter?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
        const queryFilter: { eq: (field: string, value: unknown) => unknown } = {
            eq: (field, value) => {
                this.filters.push({ field, value })
                return queryFilter
            },
        }
        filter?.(queryFilter)
        return this
    }

    order(direction: "asc" | "desc") {
        this.orderDirection = direction
        return this
    }

    async collect() {
        return this.applyFilters()
    }

    async first() {
        return this.applyFilters()[0] ?? null
    }

    async take(limit: number) {
        return this.applyFilters().slice(0, limit)
    }

    private applyFilters() {
        const filtered = this.rows.filter((row) =>
            this.filters.every((filter) => row[filter.field] === filter.value)
        )

        if (this.orderDirection === "desc") {
            return [...filtered].reverse()
        }

        return filtered
    }
}

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

describe("Convex MT5 provider close replay", () => {
    it("repairs a vanished MT5 entry order and imports broker close history after the live provider row is gone", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-mt5"
        const runId = "run-mt5"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                name: "MT5 Gold",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "mt5",
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [{
                _id: "order-entry",
                orderId: "1671162537",
                canonicalOrderId: "1671162537",
                providerOrderId: "1671162537",
                providerClientOrderId: "vmte01goldclose",
                providerOrderAliases: [],
                runId,
                strategyId,
                app: "mt5",
                venue: "mt5",
                instrument: "XAUUSD",
                status: "cancelled",
                action: "entry",
                quantity: 0.01,
                filledQuantity: 0,
                remainingQuantity: 0.01,
                submittedAt: openedAt,
                updatedAt: openedAt + 1_000,
                intent: {
                    instrument: "XAUUSD",
                    limitPrice: 4434.18,
                    metadata: {
                        estimatedPrice: 4434.18,
                    },
                    side: "sell",
                    quantity: 0.01,
                    orderType: "market",
                },
                lastTransitionSequence: 1,
                polling: {
                    pollIntervalMs: 0,
                    timeoutMs: 0,
                    startedAt: openedAt,
                    lastCheckedAt: openedAt + 1_000,
                },
            }],
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
                balance: 813.97,
                equity: 813.97,
                buyingPower: 813.97,
                marginUsed: 0,
                marginAvailable: 813.97,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: "XAUUSD",
                providerPositionId: "1671162537",
                side: "short",
                quantity: 0.01,
                fillPrice: 4457.5,
                closedAt,
                metadata: JSON.stringify({
                    orderId: 1672000000,
                    positionId: 1671162537,
                    fillPnl: -23.32,
                    profit: -23.32,
                }),
            }],
        })

        const orders = db.rows.orders ?? []
        const entryOrder = orders.find((order) => order.orderId === "1671162537")
        expect(entryOrder).toMatchObject({
            status: "filled",
            filledQuantity: 0.01,
            remainingQuantity: 0,
            avgFillPrice: 4434.18,
        })

        const closeOrder = orders.find((order) => order.action === "close")
        if (!closeOrder) {
            throw new Error("Expected MT5 provider-close order")
        }
        expect(closeOrder).toMatchObject({
            orderId: `provider-close:mt5:XAUUSD:1671162537:${closedAt}`,
            providerOrderId: "1672000000",
            runId,
            strategyId,
            instrument: "XAUUSD",
            status: "filled",
            action: "close",
            quantity: 0.01,
            filledQuantity: 0.01,
            avgFillPrice: 4457.5,
        })
        expect(((closeOrder.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            fillPnl: -23.32,
            profit: -23.32,
            providerReconciledClose: true,
            providerPositionId: "1671162537",
            providerPositionKey: "XAUUSD:1671162537",
            entryPrice: 4434.18,
            positionSide: "short",
        })
        expect(resolveCloseOrderRealizedPnl(closeOrder as never)).toBe(-23.32)
        expect(db.rows.order_transitions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                orderId: "1671162537",
                previousStatus: "cancelled",
                status: "filled",
            }),
            expect.objectContaining({
                orderId: `provider-close:mt5:XAUUSD:1671162537:${closedAt}`,
                status: "filled",
            }),
        ]))
    })

    it("attaches MT5 broker close PnL to an existing close order and retires the duplicate synthetic close", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-mt5-us30"
        const runId = "run-mt5-us30"
        const openedAt = 1_779_900_000_000
        const closedAt = openedAt + 600_000
        const providerPositionId = "1671367552"
        const syntheticOrderId = `provider-close:mt5:US30:${providerPositionId}:${closedAt}`
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                name: "MT5 US30",
                policy: { dryRun: false },
            }],
            strategy_runs: [{
                _id: runId,
                strategyId,
                app: "mt5",
                status: "completed",
                startedAt: openedAt,
                endedAt: openedAt + 30_000,
            }],
            instrument_claims: [],
            orders: [
                {
                    _id: "order-entry-us30",
                    orderId: providerPositionId,
                    canonicalOrderId: providerPositionId,
                    providerOrderId: providerPositionId,
                    providerClientOrderId: "vmte01us30entry",
                    providerOrderAliases: [],
                    runId,
                    strategyId,
                    app: "mt5",
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "entry",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50659.1,
                    submittedAt: openedAt,
                    updatedAt: openedAt + 1_000,
                    intent: {
                        instrument: "US30",
                        limitPrice: 50659.1,
                        metadata: {
                            estimatedPrice: 50659.1,
                        },
                        side: "buy",
                        quantity: 0.1,
                        orderType: "market",
                    },
                    lastTransitionSequence: 1,
                    polling: {
                        pollIntervalMs: 0,
                        timeoutMs: 0,
                        startedAt: openedAt,
                        lastCheckedAt: openedAt + 1_000,
                    },
                },
                {
                    _id: "order-close-us30",
                    orderId: "canonical-us30-close",
                    canonicalOrderId: "canonical-us30-close",
                    providerOrderId: "1671600000",
                    providerClientOrderId: "vmtc01us30close",
                    providerOrderAliases: [],
                    runId,
                    strategyId,
                    app: "mt5",
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "close",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50711.9,
                    submittedAt: closedAt - 1_000,
                    updatedAt: closedAt,
                    intent: {
                        instrument: "US30",
                        metadata: {
                            providerPositionId,
                            providerPositionKey: `US30:${providerPositionId}`,
                            entryPrice: 50659.1,
                            positionSide: "long",
                            estimatedPrice: 50711.9,
                        },
                        side: "sell",
                        quantity: 0.1,
                        orderType: "market",
                    },
                    lastTransitionSequence: 1,
                    polling: {
                        pollIntervalMs: 0,
                        timeoutMs: 0,
                        startedAt: closedAt - 1_000,
                        lastCheckedAt: closedAt,
                    },
                },
                {
                    _id: "order-synthetic-us30",
                    orderId: syntheticOrderId,
                    canonicalOrderId: syntheticOrderId,
                    providerOrderId: "1672000001",
                    providerClientOrderId: undefined,
                    providerOrderAliases: [],
                    runId,
                    strategyId,
                    app: "mt5",
                    venue: "mt5",
                    instrument: "US30",
                    status: "filled",
                    action: "close",
                    quantity: 0.1,
                    filledQuantity: 0.1,
                    remainingQuantity: 0,
                    avgFillPrice: 50711.9,
                    submittedAt: closedAt,
                    updatedAt: closedAt,
                    intent: {
                        instrument: "US30",
                        metadata: {
                            fillPnl: 5.28,
                            providerReconciledClose: true,
                            providerPositionId,
                            providerPositionKey: `US30:${providerPositionId}`,
                            entryPrice: 50659.1,
                            positionSide: "long",
                            estimatedPrice: 50711.9,
                        },
                        side: "sell",
                        quantity: 0.1,
                        orderType: "market",
                    },
                    lastTransitionSequence: 1,
                    polling: {
                        pollIntervalMs: 0,
                        timeoutMs: 0,
                        startedAt: closedAt,
                        lastCheckedAt: closedAt,
                    },
                },
            ],
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

        const reconcileArgs = {
            serviceToken: "test-token",
            app: "mt5",
            venue: "mt5",
            source: "periodic_sync",
            accountState: {
                balance: 813.97,
                equity: 813.97,
                buyingPower: 813.97,
                marginUsed: 0,
                marginAvailable: 813.97,
                openPnl: 0,
                dayPnl: 0,
            },
            positions: [],
            workingOrders: [],
            positionClosures: [{
                instrument: "US30",
                providerPositionId,
                side: "long",
                quantity: 0.1,
                fillPrice: 50711.9,
                closedAt,
                metadata: JSON.stringify({
                    orderId: 1672000001,
                    positionId: Number(providerPositionId),
                    fillPnl: 5.28,
                    profit: 5.28,
                }),
            }],
        }

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        const orders = db.rows.orders ?? []
        const canonicalClose = orders.find((order) => order.orderId === "canonical-us30-close")
        if (!canonicalClose) {
            throw new Error("Expected canonical MT5 close order")
        }
        expect(((canonicalClose.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            fillPnl: 5.28,
            providerReconciledClose: true,
            providerPositionId,
            providerPositionKey: `US30:${providerPositionId}`,
        })
        expect(resolveCloseOrderRealizedPnl(canonicalClose as never)).toBe(5.28)

        const retiredSynthetic = orders.find((order) => order.orderId === syntheticOrderId)
        if (!retiredSynthetic) {
            throw new Error("Expected retired synthetic MT5 close order")
        }
        expect(retiredSynthetic).toMatchObject({
            canonicalOrderId: "canonical-us30-close",
            status: "cancelled",
            filledQuantity: 0,
            remainingQuantity: 0.1,
        })
        expect(((retiredSynthetic.intent as Record<string, unknown>).metadata as Record<string, unknown>)).toMatchObject({
            providerReconciledCloseRetired: true,
            providerReconciledDuplicateOfOrderId: "canonical-us30-close",
        })
        expect(resolveCloseOrderRealizedPnl(retiredSynthetic as never)).toBeUndefined()

        const transitions = db.rows.order_transitions ?? []
        const orderCountAfterFirstSync = orders.length
        const transitionCountAfterFirstSync = transitions.length

        await callRegistered(reconcileProviderPortfolio, ctx, reconcileArgs)

        expect(db.rows.orders).toHaveLength(orderCountAfterFirstSync)
        expect(db.rows.order_transitions).toHaveLength(transitionCountAfterFirstSync)
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

async function callRegistered(
    registered: unknown,
    ctx: never,
    args: Record<string, unknown>
): Promise<unknown> {
    return await (registered as RegisteredFunctionForTest)._handler(ctx, args as never)
}
