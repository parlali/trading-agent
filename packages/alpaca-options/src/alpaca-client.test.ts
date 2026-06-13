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

describe("buildCreateOrderPayload", () => {
    it("splits Alpaca leg side and position intent fields for credit entries with canonical identity", () => {
        const payload = buildCreateOrderPayload(createEntryIntent(), "vale01abcdef2345")

        expect(payload).toMatchObject({
            client_order_id: "vale01abcdef2345",
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

    it("builds simple Alpaca option close payloads for single-leg leftovers", () => {
        const payload = buildCreateOrderPayload({
            instrument: "SPY260424P00650000",
            side: "buy",
            quantity: 1,
            orderType: "limit",
            limitPrice: 1.23,
            timeInForce: "day",
            legs: [{
                instrument: "SPY260424P00650000",
                side: "buy_to_close",
                quantity: 1,
            }],
        }, "valc01abcdef2345")

        expect(payload).toMatchObject({
            client_order_id: "valc01abcdef2345",
            symbol: "SPY260424P00650000",
            type: "limit",
            time_in_force: "day",
            qty: 1,
            limit_price: 1.23,
            side: "buy",
            position_intent: "buy_to_close",
        })
        expect(payload).not.toHaveProperty("order_class")
        expect(payload).not.toHaveProperty("legs")
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

    it("accepts account preflight when provider account id matches configured account", async () => {
        fetchMock.mockResolvedValue(createJsonResponse({
            id: "account-id",
            account_number: "account-number",
            equity: "1000",
            buying_power: "500",
        }))

        const account = await createClient().getAccount()

        expect(account.id).toBe("account-id")
    })

    it("accepts account preflight when provider account number matches configured account", async () => {
        fetchMock.mockResolvedValue(createJsonResponse({
            id: "provider-id",
            account_number: "account-id",
            equity: "1000",
            buying_power: "500",
        }))

        const account = await createClient().getAccount()

        expect(account.account_number).toBe("account-id")
    })

    it("rejects account preflight when credentials are bound to a different provider account", async () => {
        fetchMock.mockResolvedValue(createJsonResponse({
            id: "wrong-provider-id",
            account_number: "wrong-account-number",
            equity: "1000",
            buying_power: "500",
        }))

        await expect(createClient().getAccount()).rejects.toMatchObject({
            executionError: {
                code: "ALPACA_ACCOUNT_BINDING_MISMATCH",
                retryable: false,
                details: {
                    expectedAccountId: "account-id",
                    reportedAccountId: "wrong-provider-id",
                    reportedAccountNumber: "wrong-account-number",
                },
            },
        })
    })

    it("normalizes signed multileg credit prices on readback and replacement", async () => {
        fetchMock.mockResolvedValue(createJsonResponse(createEntryOrderResponse()))

        const readResult = await createClient().getOrder("order-entry-1")

        expect(readResult.intentUpdates?.limitPrice).toBe(1.23)

        fetchMock.mockReset()
        fetchMock
            .mockResolvedValueOnce(createJsonResponse(createEntryOrderResponse()))
            .mockResolvedValueOnce(createJsonResponse(createEntryOrderResponse("-1.1")))

        const client = createClient()
        const replaceResult = await client.replaceOrder("order-entry-1", { limitPrice: 1.1 })
        const patchInit = fetchMock.mock.calls[1]?.[1]

        expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v2/orders/order-entry-1")
        expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v2/orders/order-entry-1")
        expect(patchInit?.method).toBe("PATCH")
        expect(JSON.parse(String(patchInit?.body))).toMatchObject({
            limit_price: -1.1,
        })
        expect(replaceResult.intentUpdates?.limitPrice).toBe(1.1)
    })

    it("marks filled Alpaca order results as requiring account-activity accounting reconciliation", async () => {
        fetchMock.mockResolvedValue(createJsonResponse({
            ...createEntryOrderResponse(),
            status: "filled",
            filled_qty: "2",
            filled_avg_price: "1.20",
        }))

        const result = await createClient().getOrder("order-entry-1")

        expect(result.status).toBe("filled")
        expect(result.intentUpdates?.metadata).toMatchObject({
            providerAccountingSource: "alpaca_order",
            providerAccountingMissing: true,
            providerAccountingMissingReason: "alpaca_order_fill_requires_account_activity_fee_reconciliation",
            providerOrderId: "order-entry-1",
        })
    })

    it("retrieves account activities by type with bounded page parameters", async () => {
        fetchMock.mockResolvedValue(createJsonResponse([{
            id: "activity-expiry-1",
            activity_type: "OPEXP",
            date: "2026-05-01",
            net_amount: "0",
            symbol: "SPY260501C00720000",
            qty: "2",
            status: "executed",
        }]))

        const activities = await createClient().getAccountActivities(["OPEXP"], 24)
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
        const init = fetchMock.mock.calls[0]?.[1]

        expect(url.pathname).toBe("/v2/account/activities/OPEXP")
        expect(url.searchParams.get("direction")).toBe("asc")
        expect(url.searchParams.get("page_size")).toBe("100")
        expect(url.searchParams.get("after")).toBeTruthy()
        expect(init?.headers).toMatchObject({
            "APCA-ACCOUNT-ID": "account-id",
        })
        expect(activities[0]?.id).toBe("activity-expiry-1")
    })
})
