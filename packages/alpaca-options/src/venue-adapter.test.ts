import { describe, expect, it, vi } from "vitest"
import { AlpacaOptionsVenueAdapter } from "./venue-adapter.ts"

function createClientMock() {
    return {
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
            side: "sell",
            limitPrice: 1.23,
        })
    })
})
