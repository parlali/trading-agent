import { describe, expect, it, vi } from "vitest"
import {
    createLogger,
    ExecutionPipeline,
    type ExecutionResult,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import type { AlpacaPositionResponse } from "./alpaca-client.ts"
import { buildAlpacaStructureInstrumentFromLegs } from "./risk-rules.ts"
import { AlpacaOptionsVenueAdapter } from "./venue-adapter.ts"

function createClientMock() {
    return {
        getPositions: vi.fn().mockResolvedValue(createLoggedResetPositions()),
        getOpenOrders: vi.fn().mockResolvedValue([
            {
                id: "order-entry-1",
                order_class: "mleg",
                side: "sell",
                status: "new",
                qty: "2",
                filled_qty: "0",
                limit_price: "-1.23",
                submitted_at: "2026-04-10T10:00:00Z",
                updated_at: "2026-04-10T10:00:01Z",
                legs: [
                    {
                        symbol: "SPY260417C00550000",
                        side: "sell",
                        position_intent: "sell_to_open",
                        ratio_qty: "1",
                    },
                    {
                        symbol: "SPY260417C00555000",
                        side: "buy",
                        position_intent: "buy_to_open",
                        ratio_qty: "1",
                    },
                    {
                        symbol: "SPY260417P00500000",
                        side: "sell",
                        position_intent: "sell_to_open",
                        ratio_qty: "1",
                    },
                    {
                        symbol: "SPY260417P00495000",
                        side: "buy",
                        position_intent: "buy_to_open",
                        ratio_qty: "1",
                    },
                ],
            },
        ]),
        getAccountActivities: vi.fn().mockResolvedValue([]),
        createOrder: vi.fn().mockResolvedValue({
            orderId: "order-close-structure",
            status: "pending",
            filledQuantity: 0,
            timestamp: Date.parse("2026-04-14T10:00:00Z"),
        }),
        getOrder: vi.fn(async (orderId: string): Promise<ExecutionResult> => ({
            orderId,
            status: "pending",
            filledQuantity: 0,
            timestamp: Date.parse("2026-04-10T10:00:01Z"),
        })),
        getAccount: vi.fn().mockResolvedValue({
            equity: "10050",
            portfolio_value: "10050",
            cash: "9000",
            buying_power: "12000",
            regt_buying_power: "12000",
            initial_margin: "1000",
            maintenance_margin: "750",
            unrealized_pl: "50",
            last_equity: "10000",
        }),
        getOptionContracts: vi.fn().mockResolvedValue({
            contracts: [],
        }),
        getOptionSnapshots: vi.fn().mockResolvedValue({
            snapshots: {},
        }),
        getLatestEquityQuote: vi.fn().mockResolvedValue({
            bidPrice: 600,
            askPrice: 600.1,
            timestamp: "2026-04-10T10:00:00Z",
        }),
        getEquitySnapshot: vi.fn().mockResolvedValue({
            latestTrade: {
                price: 600.05,
                timestamp: "2026-04-10T10:00:00Z",
            },
        }),
    }
}

const testLogger = createLogger({ minLevel: "fatal" })

function createPipeline(
    venue: AlpacaOptionsVenueAdapter,
    ownedInstruments: Set<string>,
    dryRun = false
): ExecutionPipeline {
    return new ExecutionPipeline({
        venue,
        venueName: "alpaca-options",
        policy: {
            dryRun,
            safety: {
                account: {
                    allocationPercent: 100,
                },
            },
        },
        logger: testLogger,
        runId: "alpaca-options-test-run",
        strategyId: "alpaca-options-test-strategy",
        ownedInstruments,
    })
}

function createLoggedResetPositions(): AlpacaPositionResponse[] {
    return [
        createPosition("SPY260424C00685000", "short", "1", "8.37"),
        createPosition("SPY260424C00686000", "long", "1", "7.65"),
        createPosition("SPY260424C00688000", "short", "1", "6.52"),
        createPosition("SPY260424C00689000", "long", "1", "5.91"),
        createPosition("SPY260424C00690000", "short", "2", "4.55"),
        createPosition("SPY260424C00691000", "long", "2", "4.88"),
        createPosition("SPY260424C00696000", "short", "1", "2.79"),
        createPosition("SPY260424C00697000", "long", "1", "2.41"),
        createPosition("SPY260424C00705000", "short", "3", "0.67"),
        createPosition("SPY260424C00706000", "long", "3", "0.53"),
        createPosition("SPY260424P00649000", "long", "3", "0.94"),
        createPosition("SPY260424P00650000", "short", "3", "1"),
        createPosition("SPY260424P00669000", "long", "1", "2.73"),
        createPosition("SPY260424P00670000", "short", "1", "2.91"),
        createPosition("SPY260424P00672000", "long", "2", "3.21"),
        createPosition("SPY260424P00673000", "short", "2", "3.42"),
        createPosition("SPY260424P00674000", "long", "2", "3.58"),
        createPosition("SPY260424P00675000", "short", "2", "3.81"),
    ]
}

function createIronCondorPositionsWithoutCurrentPrices(): AlpacaPositionResponse[] {
    return [
        createPosition("SPY260424C00705000", "short", "1"),
        createPosition("SPY260424C00706000", "long", "1"),
        createPosition("SPY260424P00649000", "long", "1"),
        createPosition("SPY260424P00650000", "short", "1"),
    ]
}

function createIronCondorPositionsWithPrices(): AlpacaPositionResponse[] {
    return [
        createPosition("SPY260424C00705000", "short", "1", "1.50", "2.00", "0.50"),
        createPosition("SPY260424C00706000", "long", "1", "0.80", "1.00", "-0.20"),
        createPosition("SPY260424P00650000", "short", "1", "1.70", "2.20", "0.50"),
        createPosition("SPY260424P00649000", "long", "1", "0.90", "1.10", "-0.20"),
    ]
}

function createUnmatchedResidualPositions(): AlpacaPositionResponse[] {
    return [
        createPosition("SPY260424C00705000", "short", "1", "0.67"),
        createPosition("SPY260424C00706000", "long", "1", "0.53"),
        createPosition("SPY260424P00650000", "short", "1", "1"),
    ]
}

function createBullPutVerticalPositions(): AlpacaPositionResponse[] {
    return [
        {
            asset_class: "us_option",
            symbol: "SPY260424P00650000",
            side: "short",
            qty: "1",
            avg_entry_price: "2.10",
            current_price: "1.50",
            unrealized_pl: "0.60",
        },
        {
            asset_class: "us_option",
            symbol: "SPY260424P00649000",
            side: "long",
            qty: "1",
            avg_entry_price: "1.20",
            current_price: "0.90",
            unrealized_pl: "-0.30",
        },
    ]
}

function createIncidentBearCallPositions(): AlpacaPositionResponse[] {
    return [
        createPosition("SPY260803C00748000", "short", "1", "0.42", "1.79", "1.37"),
        createPosition("SPY260803C00749000", "long", "1", "0.21", "0.84", "-0.63"),
    ]
}

function createPosition(
    symbol: string,
    side: "long" | "short",
    qty: string,
    currentPrice?: string,
    entryPrice = currentPrice ?? "1",
    unrealizedPnl?: string
): AlpacaPositionResponse {
    return {
        asset_class: "us_option",
        symbol,
        side,
        qty,
        avg_entry_price: entryPrice,
        ...(currentPrice ? { current_price: currentPrice } : {}),
        ...(unrealizedPnl ? { unrealized_pl: unrealizedPnl } : {}),
    }
}

function createInvalidCreditGeometryPositions(): AlpacaPositionResponse[] {
    return [
        {
            asset_class: "us_option",
            symbol: "SPY260424C00700000",
            side: "short",
            qty: "1",
            avg_entry_price: "1.90",
            current_price: "1.60",
            unrealized_pl: "0.30",
        },
        {
            asset_class: "us_option",
            symbol: "SPY260424C00699000",
            side: "long",
            qty: "1",
            avg_entry_price: "2.30",
            current_price: "2.10",
            unrealized_pl: "-0.20",
        },
    ]
}

describe("AlpacaOptionsVenueAdapter", () => {
    it("excludes terminal transition statuses from working orders", async () => {
        const client = createClientMock()
        client.getOpenOrders.mockResolvedValueOnce([
            {
                id: "order-pending-cancel",
                order_class: "mleg",
                side: "sell",
                status: "pending_cancel",
                qty: "1",
                filled_qty: "0",
                limit_price: "-1.10",
                submitted_at: "2026-04-10T10:00:00Z",
                updated_at: "2026-04-10T10:00:01Z",
                legs: [],
            },
            {
                id: "order-cancelled",
                order_class: "mleg",
                side: "sell",
                status: "cancelled",
                qty: "1",
                filled_qty: "0",
                limit_price: "-1.10",
                submitted_at: "2026-04-10T10:00:00Z",
                updated_at: "2026-04-10T10:00:01Z",
                legs: [],
            },
            {
                id: "order-live",
                symbol: "SPY260424P00650000",
                order_class: "mleg",
                side: "sell",
                status: "new",
                qty: "1",
                filled_qty: "0",
                limit_price: "-1.10",
                submitted_at: "2026-04-10T10:00:00Z",
                updated_at: "2026-04-10T10:00:01Z",
                legs: [],
            },
        ])

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const orders = await adapter.getWorkingOrders()

        expect(orders).toHaveLength(1)
        expect(orders[0]?.orderId).toBe("order-live")
        expect(orders[0]?.status).toBe("pending")
        expect(client.getOrder).toHaveBeenCalledTimes(1)
        expect(client.getOrder).toHaveBeenCalledWith("order-live")
    })

    it("excludes Alpaca open-feed rows when direct order status is terminal", async () => {
        const client = createClientMock()
        client.getOpenOrders.mockResolvedValueOnce([{
            id: "order-stale-open",
            client_order_id: "client-order-stale-open",
            symbol: "SPY260626P00730000",
            order_class: "mleg",
            side: "sell",
            status: "new",
            qty: "1",
            filled_qty: "0",
            limit_price: "-0.10",
            submitted_at: "2026-06-16T19:01:58.372081Z",
            updated_at: "2026-06-16T19:01:58.376498Z",
            legs: [{
                symbol: "SPY260626P00730000",
                side: "sell",
                position_intent: "sell_to_open",
                ratio_qty: "1",
                status: "new",
                qty: "1",
                filled_qty: "0",
                replaces: "previous-leg-order",
            }],
        }])
        client.getOrder.mockResolvedValueOnce({
            orderId: "order-stale-open",
            providerOrderId: "order-stale-open",
            providerClientOrderId: "client-order-stale-open",
            status: "filled",
            filledQuantity: 1,
            fillPrice: -0.1,
            timestamp: Date.parse("2026-06-16T19:02:17.666Z"),
            intentUpdates: {
                quantity: 1,
                limitPrice: 0.1,
                metadata: {
                    providerAccountingSource: "alpaca_order",
                    providerOrderId: "order-stale-open",
                    providerClientOrderId: "client-order-stale-open",
                },
            },
        })

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const orders = await adapter.getWorkingOrders()

        expect(orders).toEqual([])
    })

    it("records filled Alpaca working orders as provider order accounting", async () => {
        const client = createClientMock()
        client.getOpenOrders.mockResolvedValueOnce([{
            id: "order-partial",
            symbol: "SPY260424P00650000",
            order_class: "mleg",
            side: "sell",
            status: "partially_filled",
            qty: "2",
            filled_qty: "1",
            filled_avg_price: "1.20",
            limit_price: "-1.10",
            submitted_at: "2026-04-10T10:00:00Z",
            updated_at: "2026-04-10T10:00:01Z",
            legs: [],
        }])
        client.getOrder.mockResolvedValueOnce({
            orderId: "order-partial",
            providerOrderId: "order-partial",
            status: "partially_filled",
            filledQuantity: 1,
            fillPrice: 1.2,
            timestamp: Date.parse("2026-04-10T10:00:01Z"),
        })

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const orders = await adapter.getWorkingOrders()

        expect(orders[0]?.metadata).toMatchObject({
            providerAccountingSource: "alpaca_order",
            providerOrderId: "order-partial",
        })
        expect(orders[0]?.metadata?.providerAccountingMissing).toBeUndefined()
    })

    it("fails closed when an Alpaca working order has neither legs nor option symbol", async () => {
        const client = createClientMock()
        client.getOpenOrders.mockResolvedValueOnce([{
            id: "order-legless",
            order_class: "simple",
            side: "sell",
            status: "new",
            qty: "1",
            filled_qty: "0",
            limit_price: "1.10",
            submitted_at: "2026-04-10T10:00:00Z",
            updated_at: "2026-04-10T10:00:01Z",
            legs: [],
        }])

        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        await expect(adapter.getWorkingOrders()).rejects.toMatchObject({
            executionError: {
                code: "ALPACA_WORKING_ORDER_INSTRUMENT_MISSING",
            },
        })
    })

    it("does not synthesize account-wide iron condors from raw provider legs", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createIronCondorPositionsWithPrices())

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const positions = await adapter.getPositions()

        expect(positions).toHaveLength(4)
        expect(positions.some((position) => position.instrument.startsWith("IC:"))).toBe(false)
    })

    it("keeps one-sided vertical provider legs raw until an owned claim asks for a close", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createBullPutVerticalPositions())

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const positions = await adapter.getPositions()

        expect(positions).toHaveLength(2)
        expect(positions.some((position) => position.instrument.startsWith("VS:"))).toBe(false)
        expect(positions[0]?.providerPositionId).toBe(positions[0]?.instrument)
    })

    it("maps Alpaca option expiry activities into provider closures", async () => {
        const client = createClientMock()
        client.getAccountActivities.mockResolvedValueOnce([{
            id: "activity-expiry-1",
            activity_type: "OPEXP",
            date: "2026-05-01",
            net_amount: "0",
            description: "Option Expiry",
            symbol: "SPY260501C00720000",
            qty: "2",
            status: "executed",
        }])

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const closures = await adapter.getRecentPositionClosures()

        expect(client.getAccountActivities).toHaveBeenCalledWith(["OPEXP", "OPEXC", "OPASN"])
        expect(closures).toEqual([
            expect.objectContaining({
                instrument: "SPY260501C00720000",
                providerPositionId: "SPY260501C00720000",
                side: "short",
                quantity: 2,
                fillPrice: 0,
                closedAt: Date.parse("2026-05-01T23:59:59.999Z"),
                metadata: expect.objectContaining({
                    providerAccountingSource: "alpaca_account_activity",
                    providerActivityId: "activity-expiry-1",
                    activityType: "OPEXP",
                }),
            }),
        ])
        expect(closures[0]?.metadata).not.toHaveProperty("fillPnl")
    })

    it("maps Alpaca fee activities into account PnL events", async () => {
        const client = createClientMock()
        client.getAccountActivities.mockResolvedValueOnce([{
            id: "activity-fee-1",
            activity_type: "FEE",
            transaction_time: "2026-05-01T20:15:00Z",
            net_amount: "-0.13",
            description: "Options regulatory fee",
            symbol: "SPY260501C00720000",
            status: "executed",
        }])

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const events = await adapter.getAccountPnlEvents()

        expect(client.getAccountActivities).toHaveBeenCalledWith([
            "FEE", "CFEE", "PTC", "OPCSH", "JNLC", "JNLS", "INT", "DIV", "MISC",
        ])
        expect(events).toEqual([
            expect.objectContaining({
                providerEventId: "alpaca-activity:activity-fee-1",
                eventType: "fee",
                instrument: "SPY260501C00720000",
                amount: -0.13,
                currency: "USD",
                occurredAt: Date.parse("2026-05-01T20:15:00Z"),
                metadata: expect.objectContaining({
                    providerAccountingSource: "alpaca_account_activity",
                    activityType: "FEE",
                }),
            }),
        ])
    })

    it("keeps invalid non-credit spread geometry as residual legs instead of grouping it", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createInvalidCreditGeometryPositions())

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const positions = await adapter.getPositions()

        expect(positions).toHaveLength(2)
        expect(positions.some((position) => position.instrument.startsWith("VS:"))).toBe(false)
        expect(positions.some((position) => position.instrument.startsWith("IC:"))).toBe(false)
    })

    it("submits close orders as 4-leg structures", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createIronCondorPositionsWithPrices())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const target = buildAlpacaStructureInstrumentFromLegs({
            structureType: "iron_condor",
            underlying: "SPY",
            expiration: "2026-04-24",
            legs: [
                { instrument: "SPY260424C00705000" },
                { instrument: "SPY260424C00706000" },
                { instrument: "SPY260424P00650000" },
                { instrument: "SPY260424P00649000" },
            ],
        })

        await adapter.closePosition(target)

        expect(client.createOrder).toHaveBeenCalledTimes(1)
        const payload = client.createOrder.mock.calls[0]?.[0]
        expect(payload?.legs).toHaveLength(4)
        expect(payload?.legs.map((leg: { side: string }) => leg.side).sort()).toEqual([
            "buy_to_close",
            "buy_to_close",
            "sell_to_close",
            "sell_to_close",
        ])
    })

    it("submits close orders as 2-leg structures for one-sided vertical spreads", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createBullPutVerticalPositions())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const target = buildAlpacaStructureInstrumentFromLegs({
            structureType: "credit_vertical",
            verticalSpreadType: "bull_put_credit",
            underlying: "SPY",
            expiration: "2026-04-24",
            legs: [
                { instrument: "SPY260424P00650000" },
                { instrument: "SPY260424P00649000" },
            ],
        })

        await adapter.closePosition(target)

        expect(client.createOrder).toHaveBeenCalledTimes(1)
        const payload = client.createOrder.mock.calls[0]?.[0]
        expect(payload?.legs).toHaveLength(2)
        expect(payload?.legs.map((leg: { side: string }) => leg.side).sort()).toEqual([
            "buy_to_close",
            "sell_to_close",
        ])
        expect(payload?.metadata).toMatchObject({
            structureType: "credit_vertical",
            verticalSpreadType: "bull_put_credit",
            entryPrice: 0.9,
            positionSide: "short",
        })
    })

    it("closes raw provider legs through exact claimed vertical evidence", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createBullPutVerticalPositions())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claimInstrument = buildAlpacaStructureInstrumentFromLegs({
            structureType: "credit_vertical",
            verticalSpreadType: "bull_put_credit",
            underlying: "SPY",
            expiration: "2026-04-24",
            legs: [
                { instrument: "SPY260424P00650000" },
                { instrument: "SPY260424P00649000" },
            ],
        })

        await adapter.closeProviderPosition({
            instrument: "SPY260424P00650000",
            providerPositionId: "SPY260424P00650000:short",
            side: "short",
            quantity: 1,
            entryPrice: 2.1,
            currentPrice: 1.5,
            metadata: {
                alpacaClaimInstrument: claimInstrument,
            },
        })

        const payload = client.createOrder.mock.calls[0]?.[0]
        expect(payload?.instrument).toBe(claimInstrument)
        expect(payload?.legs).toHaveLength(2)
        expect(payload?.orderType).toBe("limit")
    })

    it("resolves a provider leg close target to the complete owned claimed bear call structure", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce([
            createPosition("SPY260724C00763000", "short", "1", "0.42", "1.79", "1.37"),
            createPosition("SPY260724C00764000", "long", "1", "0.21", "0.84", "-0.63"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claimInstrument = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00763000|SPY260724C00764000"

        const target = await adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00763000",
            providerPositionId: "SPY260724C00763000",
            side: "short",
            quantity: 1,
            entryPrice: 1.79,
            currentPrice: 0.42,
        }, new Set([claimInstrument]))

        expect(target).toEqual({
            claimInstrument,
            legInstruments: [
                "SPY260724C00763000",
                "SPY260724C00764000",
            ],
        })
    })

    it("rejects raw single-leg closes on live claimed structures and leaves orphan legs single-leg eligible", async () => {
        const shortLeg = "SPY260803C00748000"
        const longLeg = "SPY260803C00749000"
        const claimInstrument = `VS:BEAR_CALL_CREDIT:SPY:2026-08-03:${shortLeg}|${longLeg}`
        const claimedClient = createClientMock()
        claimedClient.getPositions.mockResolvedValue(createIncidentBearCallPositions())
        const claimedAdapter = new AlpacaOptionsVenueAdapter(claimedClient as never)
        const claimedPipeline = createPipeline(claimedAdapter, new Set([claimInstrument, shortLeg, longLeg]))

        const rejected = await claimedPipeline.closePosition(shortLeg, "incident replay raw leg close")

        expect(rejected.validation.allowed).toBe(false)
        expect(rejected.result.status).toBe("rejected")
        expect(rejected.result.errorDetail).toMatchObject({
            code: "ALPACA_RAW_LEG_CLOSE_CLAIMED_STRUCTURE",
            retryable: false,
            details: {
                claimInstrument,
                legInstruments: [
                    shortLeg,
                    longLeg,
                ],
            },
        })
        expect(rejected.result.error).toContain(claimInstrument)
        expect(rejected.result.error).toContain("structure-close")
        expect(claimedClient.createOrder).not.toHaveBeenCalled()

        const orphanClient = createClientMock()
        orphanClient.getPositions.mockResolvedValue([createIncidentBearCallPositions()[0]!])
        const orphanAdapter = new AlpacaOptionsVenueAdapter(orphanClient as never)
        const orphanPipeline = createPipeline(orphanAdapter, new Set([shortLeg]))
        const orphanPosition: Position = {
            instrument: shortLeg,
            providerPositionId: shortLeg,
            side: "short",
            quantity: 1,
            entryPrice: 1.79,
            currentPrice: 0.42,
        }

        const orphanClose = await orphanPipeline.closeProviderPosition(orphanPosition, "claim released orphan close")

        expect(orphanClose.validation.allowed).toBe(true)
        expect(orphanClose.result.status).toBe("pending")
        const payload = orphanClient.createOrder.mock.calls[0]?.[0]
        expect(payload).toMatchObject({
            instrument: shortLeg,
            side: "buy",
            orderType: "limit",
            limitPrice: 0.42,
            legs: [{
                instrument: shortLeg,
                side: "buy_to_close",
                quantity: 1,
            }],
            metadata: {
                structureType: "single_option",
            },
        })
    })

    it("allows whole-structure closes for the same claimed legs", async () => {
        const shortLeg = "SPY260803C00748000"
        const longLeg = "SPY260803C00749000"
        const claimInstrument = `VS:BEAR_CALL_CREDIT:SPY:2026-08-03:${shortLeg}|${longLeg}`
        const client = createClientMock()
        client.getPositions.mockResolvedValue(createIncidentBearCallPositions())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const pipeline = createPipeline(adapter, new Set([claimInstrument, shortLeg, longLeg]))

        const result = await pipeline.closePosition(claimInstrument, "close entire claimed structure")

        expect(result.validation.allowed).toBe(true)
        expect(result.result.status).toBe("pending")
        const payload = client.createOrder.mock.calls[0]?.[0]
        expect(payload).toMatchObject({
            instrument: claimInstrument,
            side: "buy",
            quantity: 1,
            orderType: "limit",
            legs: [
                {
                    instrument: shortLeg,
                    side: "buy_to_close",
                    quantity: 1,
                },
                {
                    instrument: longLeg,
                    side: "sell_to_close",
                    quantity: 1,
                },
            ],
        })
    })

    it("enforces raw-leg structure ownership in dry-run books", async () => {
        const shortLeg = "SPY260803C00748000"
        const longLeg = "SPY260803C00749000"
        const claimInstrument = `VS:BEAR_CALL_CREDIT:SPY:2026-08-03:${shortLeg}|${longLeg}`
        const adapter = new AlpacaOptionsVenueAdapter(createClientMock() as never)
        const claimedPipeline = createPipeline(adapter, new Set([claimInstrument, shortLeg, longLeg]), true)
        claimedPipeline.seedDryRunPositions([
            {
                instrument: shortLeg,
                side: "short",
                quantity: 1,
                entryPrice: 1.79,
                currentPrice: 0.42,
            },
            {
                instrument: longLeg,
                side: "long",
                quantity: 1,
                entryPrice: 0.84,
                currentPrice: 0.21,
            },
        ])

        const claimedResult = await claimedPipeline.closePosition(shortLeg, "dry-run claimed raw leg")

        expect(claimedResult.validation.allowed).toBe(false)
        expect(claimedResult.result.errorDetail?.code).toBe("ALPACA_RAW_LEG_CLOSE_CLAIMED_STRUCTURE")

        const orphanPipeline = createPipeline(adapter, new Set([shortLeg]), true)
        orphanPipeline.seedDryRunPositions([
            {
                instrument: shortLeg,
                side: "short",
                quantity: 1,
                entryPrice: 1.79,
                currentPrice: 0.42,
            },
        ])

        const orphanResult = await orphanPipeline.closePosition(shortLeg, "dry-run orphan raw leg")

        expect(orphanResult.validation.allowed).toBe(true)
        expect(orphanResult.result.status).toBe("filled")
    })

    it("uses the exact live leg set before rejecting raw shared-wing closes", async () => {
        const sharedLongLeg = "SPY260724C00753000"
        const claim751 = `VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00751000|${sharedLongLeg}`
        const claim752 = `VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00752000|${sharedLongLeg}`
        const client = createClientMock()
        client.getPositions.mockResolvedValue([
            createPosition("SPY260724C00751000", "short", "1", "0.17", "1.67", "150"),
            createPosition(sharedLongLeg, "long", "1", "0.08", "1.12", "-104"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const pipeline = createPipeline(adapter, new Set([
            claim751,
            claim752,
            "SPY260724C00751000",
            sharedLongLeg,
        ]))

        const result = await pipeline.closePosition(sharedLongLeg, "raw shared wing replay")

        expect(result.validation.allowed).toBe(false)
        expect(result.result.errorDetail).toMatchObject({
            code: "ALPACA_RAW_LEG_CLOSE_CLAIMED_STRUCTURE",
            details: {
                claimInstrument: claim751,
                legInstruments: [
                    "SPY260724C00751000",
                    sharedLongLeg,
                ],
            },
        })
        expect(result.result.error).toContain(claim751)
        expect(client.createOrder).not.toHaveBeenCalled()
    })

    it("keeps provider leg close single-leg eligible when the owned claimed structure is incomplete", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce([
            createPosition("SPY260724C00764000", "long", "1", "0.21", "0.84", "-0.63"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claimInstrument = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00763000|SPY260724C00764000"

        const target = await adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00764000",
            providerPositionId: "SPY260724C00764000",
            side: "long",
            quantity: 1,
            entryPrice: 0.84,
            currentPrice: 0.21,
        }, new Set([claimInstrument]))

        expect(target).toBeNull()
    })

    it("fails closed when a provider leg belongs to multiple owned claimed structures", async () => {
        const client = createClientMock()
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        await expect(adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00763000",
            providerPositionId: "SPY260724C00763000",
            side: "short",
            quantity: 1,
            entryPrice: 1.79,
            currentPrice: 0.42,
        }, new Set([
            "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00763000|SPY260724C00764000",
            "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00763000|SPY260724C00765000",
        ]))).rejects.toMatchObject({
            executionError: {
                code: "AMBIGUOUS_STRUCTURE_CLAIM",
                retryable: false,
            },
        })
        expect(client.getPositions).not.toHaveBeenCalled()
    })

    it("resolves stacked bear-call closes with a shared long wing in one run, then leaves the residual wing single-leg eligible", async () => {
        const client = createClientMock()
        client.getPositions
            .mockResolvedValueOnce([
                createPosition("SPY260724C00751000", "short", "1", "0.17", "1.67", "150"),
                createPosition("SPY260724C00752000", "short", "1", "0.12", "1.50", "138"),
                createPosition("SPY260724C00753000", "long", "2", "0.08", "1.12", "-208"),
            ])
            .mockResolvedValueOnce([
                createPosition("SPY260724C00752000", "short", "1", "0.12", "1.50", "138"),
                createPosition("SPY260724C00753000", "long", "1", "0.08", "1.12", "-104"),
            ])
            .mockResolvedValueOnce([
                createPosition("SPY260724C00753000", "long", "2", "0.08", "1.12", "-208"),
            ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claim751 = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00751000|SPY260724C00753000"
        const claim752 = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00752000|SPY260724C00753000"
        const claims = new Set([claim751, claim752])

        const first = await adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00751000",
            providerPositionId: "SPY260724C00751000",
            side: "short",
            quantity: 1,
            entryPrice: 1.67,
            currentPrice: 0.17,
        }, claims)
        const second = await adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00752000",
            providerPositionId: "SPY260724C00752000",
            side: "short",
            quantity: 1,
            entryPrice: 1.5,
            currentPrice: 0.12,
        }, claims)
        const residual = await adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00753000",
            providerPositionId: "SPY260724C00753000",
            side: "long",
            quantity: 2,
            entryPrice: 1.12,
            currentPrice: 0.08,
        }, claims)

        expect(first?.claimInstrument).toBe(claim751)
        expect(first?.closeIntent?.quantity).toBe(1)
        expect(first?.closeIntent?.legs).toEqual([
            {
                instrument: "SPY260724C00751000",
                side: "buy_to_close",
                quantity: 1,
            },
            {
                instrument: "SPY260724C00753000",
                side: "sell_to_close",
                quantity: 1,
            },
        ])
        expect(second).toEqual({
            claimInstrument: claim752,
            legInstruments: [
                "SPY260724C00752000",
                "SPY260724C00753000",
            ],
        })
        expect(residual).toBeNull()
    })

    it("uses the unique exact live leg set when multiple owned claims contain the requested long leg", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce([
            createPosition("SPY260724C00751000", "short", "1", "0.17", "1.67", "150"),
            createPosition("SPY260724C00753000", "long", "1", "0.08", "1.12", "-104"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claim751 = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00751000|SPY260724C00753000"
        const claim752 = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00752000|SPY260724C00753000"

        const target = await adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00753000",
            providerPositionId: "SPY260724C00753000",
            side: "long",
            quantity: 1,
            entryPrice: 1.12,
            currentPrice: 0.08,
        }, new Set([claim751, claim752]))

        expect(target).toEqual({
            claimInstrument: claim751,
            legInstruments: [
                "SPY260724C00751000",
                "SPY260724C00753000",
            ],
        })
    })

    it("fails closed when duplicate exact claims match the same complete live leg set", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce([
            createPosition("SPY260724C00751000", "short", "1", "0.17", "1.67", "150"),
            createPosition("SPY260724C00753000", "long", "1", "0.08", "1.12", "-104"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claimInstrument = "VS:BEAR_CALL_CREDIT:SPY:2026-07-24:SPY260724C00751000|SPY260724C00753000"

        await expect(adapter.resolveProviderCloseStructureTarget({
            instrument: "SPY260724C00753000",
            providerPositionId: "SPY260724C00753000",
            side: "long",
            quantity: 1,
            entryPrice: 1.12,
            currentPrice: 0.08,
        }, [claimInstrument, claimInstrument])).rejects.toMatchObject({
            executionError: {
                code: "AMBIGUOUS_STRUCTURE_CLAIM",
                retryable: false,
            },
        })
    })

    it("fails closed when exact claimed vertical legs have reversed provider sides", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce([
            createPosition("SPY260424P00650000", "long", "1", "2.10", "1.50", "0.60"),
            createPosition("SPY260424P00649000", "short", "1", "1.20", "0.90", "-0.30"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claimInstrument = buildAlpacaStructureInstrumentFromLegs({
            structureType: "credit_vertical",
            verticalSpreadType: "bull_put_credit",
            underlying: "SPY",
            expiration: "2026-04-24",
            legs: [
                { instrument: "SPY260424P00650000" },
                { instrument: "SPY260424P00649000" },
            ],
        })

        await expect(adapter.closeProviderPosition({
            instrument: "SPY260424P00650000",
            providerPositionId: "SPY260424P00650000:short",
            side: "short",
            quantity: 1,
            entryPrice: 2.1,
            currentPrice: 1.5,
            metadata: {
                alpacaClaimInstrument: claimInstrument,
            },
        })).rejects.toMatchObject({
            executionError: {
                code: "POSITION_NOT_FOUND",
            },
        })
        expect(client.createOrder).not.toHaveBeenCalled()
    })

    it("fails closed when exact claimed vertical legs have mismatched quantities", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce([
            createPosition("SPY260424P00650000", "short", "2", "2.10", "1.50", "0.60"),
            createPosition("SPY260424P00649000", "long", "1", "1.20", "0.90", "-0.30"),
        ])
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const claimInstrument = buildAlpacaStructureInstrumentFromLegs({
            structureType: "credit_vertical",
            verticalSpreadType: "bull_put_credit",
            underlying: "SPY",
            expiration: "2026-04-24",
            legs: [
                { instrument: "SPY260424P00650000" },
                { instrument: "SPY260424P00649000" },
            ],
        })

        await expect(adapter.closeProviderPosition({
            instrument: "SPY260424P00650000",
            providerPositionId: "SPY260424P00650000:short",
            side: "short",
            quantity: 1,
            entryPrice: 2.1,
            currentPrice: 1.5,
            metadata: {
                alpacaClaimInstrument: claimInstrument,
            },
        })).rejects.toMatchObject({
            executionError: {
                code: "POSITION_NOT_FOUND",
            },
        })
        expect(client.createOrder).not.toHaveBeenCalled()
    })

    it("submits raw leftover provider legs as single-leg close orders", async () => {
        const client = createClientMock()
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        await adapter.closeProviderPosition({
            instrument: "SPY260424P00650000",
            side: "short",
            quantity: 1,
            entryPrice: 2.1,
            currentPrice: 1.5,
        })

        expect(client.createOrder).toHaveBeenCalledTimes(1)
        const payload = client.createOrder.mock.calls[0]?.[0]
        expect(payload).toMatchObject({
            instrument: "SPY260424P00650000",
            side: "buy",
            quantity: 1,
            orderType: "limit",
            limitPrice: 1.5,
            timeInForce: "day",
            legs: [{
                instrument: "SPY260424P00650000",
                side: "buy_to_close",
                quantity: 1,
            }],
            metadata: expect.objectContaining({
                action: "close",
                positionSide: "short",
                structureType: "single_option",
            }),
        })
    })

    it("fails closed instead of pricing structure close orders from entry prices", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createIronCondorPositionsWithoutCurrentPrices())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const target = buildAlpacaStructureInstrumentFromLegs({
            structureType: "iron_condor",
            underlying: "SPY",
            expiration: "2026-04-24",
            legs: [
                { instrument: "SPY260424C00705000" },
                { instrument: "SPY260424C00706000" },
                { instrument: "SPY260424P00650000" },
                { instrument: "SPY260424P00649000" },
            ],
        })

        await expect(adapter.buildCloseIntent(target)).rejects.toMatchObject({
            executionError: {
                code: "POSITION_PRICE_UNAVAILABLE",
                retryable: false,
            },
        })
        expect(client.createOrder).not.toHaveBeenCalled()
    })

    it("fails closed when provider legs cannot be reconstructed into a 4-leg close structure", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createUnmatchedResidualPositions())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        await expect(adapter.buildCloseIntent("SPY260424P00650000")).rejects.toMatchObject({
            executionError: {
                code: "POSITION_NOT_FOUND",
                retryable: false,
            },
        })
        expect(client.createOrder).not.toHaveBeenCalled()
    })

    it("blocks entries whose claimed short-strike delta contradicts the live chain", async () => {
        const client = createClientMock()
        client.getOptionContracts.mockResolvedValue({
            contracts: [
                { symbol: "SPY260805P00700000" },
                { symbol: "SPY260805P00699000" },
            ],
        })
        client.getOptionSnapshots.mockResolvedValue({
            snapshots: {
                SPY260805P00700000: {
                    latestQuote: { bidPrice: 0.6, askPrice: 0.7 },
                    greeks: { delta: -0.32 },
                },
                SPY260805P00699000: {
                    latestQuote: { bidPrice: 0.3, askPrice: 0.4 },
                    greeks: { delta: -0.24 },
                },
            },
        })
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        const mismatched = await adapter.verify(createBullPutEntryIntent({ shortStrikeDelta: -0.15 }))

        expect(mismatched.ok).toBe(false)
        expect(mismatched.status).toBe("block")
        expect(mismatched.message).toContain("SPY260805P00700000")
        expect(mismatched.message).toContain("claimed -0.15")
        expect(mismatched.message).toContain("chain -0.32")

        const verified = await adapter.verify(createBullPutEntryIntent({ shortStrikeDelta: -0.3 }))

        expect(verified.ok).toBe(true)
        expect(verified.status).toBeUndefined()
    })

    it("blocks entries when the chain carries no delta or the claim is absent", async () => {
        const client = createClientMock()
        client.getOptionContracts.mockResolvedValue({
            contracts: [
                { symbol: "SPY260805P00700000" },
                { symbol: "SPY260805P00699000" },
            ],
        })
        client.getOptionSnapshots.mockResolvedValue({
            snapshots: {
                SPY260805P00700000: {
                    latestQuote: { bidPrice: 0.6, askPrice: 0.7 },
                },
                SPY260805P00699000: {
                    latestQuote: { bidPrice: 0.3, askPrice: 0.4 },
                },
            },
        })
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        const unverifiable = await adapter.verify(createBullPutEntryIntent({ shortStrikeDelta: -0.18 }))

        expect(unverifiable.status).toBe("block")
        expect(unverifiable.message).toContain("no delta for SPY260805P00700000")

        const missingClaim = await adapter.verify(createBullPutEntryIntent())

        expect(missingClaim.status).toBe("block")
        expect(missingClaim.message).toContain("supply shortStrikeDelta")
    })

})

function createBullPutEntryIntent(metadata?: Record<string, unknown>): OrderIntent {
    return {
        instrument: "VS:BULL_PUT_CREDIT:SPY:2026-08-05:SPY260805P00699000|SPY260805P00700000",
        side: "sell",
        quantity: 1,
        orderType: "limit",
        limitPrice: 0.3,
        timeInForce: "day",
        metadata,
        legs: [
            {
                instrument: "SPY260805P00700000",
                side: "sell_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260805P00699000",
                side: "buy_to_open",
                quantity: 1,
            },
        ],
    }
}
