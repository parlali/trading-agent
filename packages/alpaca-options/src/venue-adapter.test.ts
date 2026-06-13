import { describe, expect, it, vi } from "vitest"
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
    })

    it("marks filled Alpaca working orders as missing provider accounting until activities reconcile fees", async () => {
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

        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const orders = await adapter.getWorkingOrders()

        expect(orders[0]?.metadata).toMatchObject({
            providerAccountingSource: "alpaca_order",
            providerAccountingMissing: true,
            providerAccountingMissingReason: "alpaca_working_order_fill_requires_account_activity_fee_reconciliation",
            providerOrderId: "order-partial",
        })
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
                closedAt: Date.parse("2026-05-01"),
                metadata: expect.objectContaining({
                    providerAccountingSource: "alpaca_account_activity",
                    providerActivityId: "activity-expiry-1",
                    activityType: "OPEXP",
                    fillPnl: 0,
                }),
            }),
        ])
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

        expect(client.getAccountActivities).toHaveBeenCalledWith(["FEE"])
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

})
