import { afterEach, describe, expect, it, vi } from "vitest"
import { OKXClient } from "./okx-client"

describe("OKXClient rejection diagnostics", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("preserves provider subcodes and sanitized request shape for order placement failures", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
            code: "0",
            msg: "",
            data: [
                {
                    ordId: "",
                    sCode: "51008",
                    sMsg: "All operations failed",
                },
            ],
        }), {
            status: 200,
            headers: {
                "content-type": "application/json",
            },
        }))

        const client = new OKXClient({
            apiKey: "key",
            apiSecret: "secret",
            apiPassphrase: "passphrase",
            demoTrading: true,
        })

        await expect(client.placeOrder({
            instId: "BTC-USDT-SWAP",
            tdMode: "isolated",
            side: "buy",
            ordType: "market",
            sz: "1",
            posSide: "net",
            attachAlgoOrds: [
                {
                    slTriggerPx: "78000",
                    slOrdPx: "-1",
                },
            ],
        })).rejects.toMatchObject({
            executionError: {
                details: {
                    path: "/api/v5/trade/order",
                    sCode: "51008",
                    sMsg: "All operations failed",
                    request: expect.objectContaining({
                        instId: "BTC-USDT-SWAP",
                        attachAlgoOrds: [
                            {
                                slTriggerPx: "78000",
                                slOrdPx: "-1",
                            },
                        ],
                    }),
                },
            },
        })
    })

})
