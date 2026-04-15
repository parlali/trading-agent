import { describe, expect, it, vi } from "vitest"
import type { AlpacaPositionResponse } from "./alpaca-client.ts"
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
        createOrder: vi.fn().mockResolvedValue({
            orderId: "order-close-structure",
            status: "pending",
            filledQuantity: 0,
            timestamp: Date.parse("2026-04-14T10:00:00Z"),
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

function createUnmatchedResidualPositions(): AlpacaPositionResponse[] {
    return [
        createPosition("SPY260424C00705000", "short", "1", "0.67"),
        createPosition("SPY260424C00706000", "long", "1", "0.53"),
        createPosition("SPY260424P00650000", "short", "1", "1"),
    ]
}

function createPosition(
    symbol: string,
    side: "long" | "short",
    qty: string,
    currentPrice?: string
): AlpacaPositionResponse {
    return {
        asset_class: "us_option",
        symbol,
        side,
        qty,
        avg_entry_price: currentPrice ?? "1",
        ...(currentPrice ? { current_price: currentPrice } : {}),
    }
}

describe("AlpacaOptionsVenueAdapter", () => {
    it("normalizes working entry orders to positive internal limit prices", async () => {
        const client = createClientMock()
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        const orders = await adapter.getWorkingOrders()

        expect(orders).toHaveLength(1)
        expect(orders[0]).toMatchObject({
            orderId: "order-entry-1",
            instrument: "IC:SPY:2026-04-17:SPY260417C00550000|SPY260417C00555000|SPY260417P00495000|SPY260417P00500000",
            side: "sell",
            limitPrice: 1.23,
        })
    })

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

    it("decomposes same-expiry provider legs into multi-leg structures", async () => {
        const client = createClientMock()
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        const positions = await adapter.getPositions()

        expect(positions.every((position) => position.instrument.startsWith("IC:SPY:2026-04-24:"))).toBe(true)
        expect(positions.reduce((sum, position) => sum + position.quantity, 0)).toBe(8)
    })

    it("submits close orders as 4-leg structures", async () => {
        const client = createClientMock()
        const adapter = new AlpacaOptionsVenueAdapter(client as never)
        const positions = await adapter.getPositions()
        const target = positions[0]

        expect(target).toBeDefined()
        await adapter.closePosition(target?.instrument ?? "")

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

    it("fails closed instead of pricing structure close orders from entry prices", async () => {
        const client = createClientMock()
        client.getPositions.mockResolvedValueOnce(createIronCondorPositionsWithoutCurrentPrices())
        const adapter = new AlpacaOptionsVenueAdapter(client as never)

        await expect(adapter.buildCloseIntent("SPY")).rejects.toMatchObject({
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
