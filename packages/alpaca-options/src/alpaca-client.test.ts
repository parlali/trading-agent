import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrderIntent } from "@valiq-trading/core"
import { AlpacaClient, buildCreateOrderPayload } from "./alpaca-client.ts"
import { resolveAlpacaRuntimeConfig } from "./runtime-config"

function createEntryIntent(): OrderIntent {
    return {
        instrument: "IC:SPY:2026-04-17:1",
        side: "sell",
        quantity: 2,
        orderType: "limit",
        limitPrice: 1.23,
        timeInForce: "day",
        legs: [
            {
                instrument: "SPY260417C00550000",
                side: "sell_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260417C00555000",
                side: "buy_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260417P00500000",
                side: "sell_to_open",
                quantity: 1,
            },
            {
                instrument: "SPY260417P00495000",
                side: "buy_to_open",
                quantity: 1,
            },
        ],
    }
}

function createCloseIntent(): OrderIntent {
    return {
        instrument: "IC:SPY:2026-04-17:1",
        side: "buy",
        quantity: 2,
        orderType: "limit",
        limitPrice: 0.67,
        timeInForce: "day",
        metadata: {
            action: "close",
        },
        legs: [
            {
                instrument: "SPY260417C00550000",
                side: "buy_to_close",
                quantity: 1,
            },
            {
                instrument: "SPY260417C00555000",
                side: "sell_to_close",
                quantity: 1,
            },
            {
                instrument: "SPY260417P00500000",
                side: "buy_to_close",
                quantity: 1,
            },
            {
                instrument: "SPY260417P00495000",
                side: "sell_to_close",
                quantity: 1,
            },
        ],
    }
}

function createClient(): AlpacaClient {
    return new AlpacaClient(resolveAlpacaRuntimeConfig({
        ALPACA_API_KEY: "key",
        ALPACA_SECRET_KEY: "secret",
        ALPACA_ACCOUNT_ID: "account-id",
        ALPACA_ENVIRONMENT: "paper",
    }))
}

function createJsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
    })
}

function createEntryOrderResponse(limitPrice = "-1.23") {
    return {
        id: "order-entry-1",
        order_class: "mleg",
        side: "sell",
        status: "new",
        qty: "2",
        filled_qty: "0",
        limit_price: limitPrice,
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
    }
}

function createCloseOrderResponse(limitPrice = "0.67") {
    return {
        id: "order-close-1",
        order_class: "mleg",
        side: "buy",
        status: "new",
        qty: "2",
        filled_qty: "0",
        limit_price: limitPrice,
        submitted_at: "2026-04-10T11:00:00Z",
        updated_at: "2026-04-10T11:00:01Z",
        legs: [
            {
                symbol: "SPY260417C00550000",
                side: "buy",
                position_intent: "buy_to_close",
                ratio_qty: "1",
            },
            {
                symbol: "SPY260417C00555000",
                side: "sell",
                position_intent: "sell_to_close",
                ratio_qty: "1",
            },
            {
                symbol: "SPY260417P00500000",
                side: "buy",
                position_intent: "buy_to_close",
                ratio_qty: "1",
            },
            {
                symbol: "SPY260417P00495000",
                side: "sell",
                position_intent: "sell_to_close",
                ratio_qty: "1",
            },
        ],
    }
}

describe("buildCreateOrderPayload", () => {
    it("splits Alpaca leg side and position intent fields for credit entries", () => {
        const payload = buildCreateOrderPayload(createEntryIntent())

        expect(payload).toMatchObject({
            order_class: "mleg",
            type: "limit",
            time_in_force: "day",
            qty: 2,
            limit_price: -1.23,
            legs: [
                {
                    symbol: "SPY260417C00550000",
                    ratio_qty: 1,
                    side: "sell",
                    position_intent: "sell_to_open",
                },
                {
                    symbol: "SPY260417C00555000",
                    ratio_qty: 1,
                    side: "buy",
                    position_intent: "buy_to_open",
                },
                {
                    symbol: "SPY260417P00500000",
                    ratio_qty: 1,
                    side: "sell",
                    position_intent: "sell_to_open",
                },
                {
                    symbol: "SPY260417P00495000",
                    ratio_qty: 1,
                    side: "buy",
                    position_intent: "buy_to_open",
                },
            ],
        })
    })

    it("keeps close debit wire prices positive", () => {
        const payload = buildCreateOrderPayload(createCloseIntent())

        expect(payload).toMatchObject({
            order_class: "mleg",
            type: "limit",
            time_in_force: "day",
            qty: 2,
            limit_price: 0.67,
        })
    })
})

describe("AlpacaClient multileg signed limit prices", () => {
    const fetchMock = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("normalizes signed entry order readbacks to positive internal prices", async () => {
        fetchMock.mockResolvedValue(createJsonResponse(createEntryOrderResponse()))

        const result = await createClient().getOrder("order-entry-1")

        expect(result.intentUpdates?.limitPrice).toBe(1.23)
    })

    it("preserves positive debit readbacks for close orders", async () => {
        fetchMock.mockResolvedValue(createJsonResponse(createCloseOrderResponse()))

        const result = await createClient().getOrder("order-close-1")

        expect(result.intentUpdates?.limitPrice).toBe(0.67)
    })

    it("uses signed negative wire prices when replacing working credit entries", async () => {
        fetchMock
            .mockResolvedValueOnce(createJsonResponse(createEntryOrderResponse()))
            .mockResolvedValueOnce(createJsonResponse(createEntryOrderResponse("-1.1")))

        const client = createClient()
        const result = await client.replaceOrder("order-entry-1", { limitPrice: 1.1 })
        const patchInit = fetchMock.mock.calls[1]?.[1]

        expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v2/orders/order-entry-1")
        expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v2/orders/order-entry-1")
        expect(patchInit?.method).toBe("PATCH")
        expect(JSON.parse(String(patchInit?.body))).toMatchObject({
            limit_price: -1.1,
        })
        expect(result.intentUpdates?.limitPrice).toBe(1.1)
    })
})
