import { describe, expect, it, vi } from "vitest"
import { OKXVenueAdapter } from "./venue-adapter"

const btcInstrument = {
    instId: "BTC-USDT-SWAP",
    instType: "SWAP",
    state: "live",
    baseCcy: "BTC",
    quoteCcy: "USDT",
    settleCcy: "USDT",
    ctVal: "0.01",
    ctValCcy: "BTC",
    lotSz: "0.01",
    minSz: "0.01",
    tickSz: "0.1",
}

describe("OKXVenueAdapter protection orders", () => {
    it("attaches TP/SL to entry orders using provider-native attached algo parameters", async () => {
        const client = {
            getInstruments: vi.fn().mockResolvedValue([btcInstrument]),
            getAccountConfig: vi.fn().mockResolvedValue({ acctLv: "2", posMode: "net_mode" }),
            setLeverage: vi.fn().mockResolvedValue(undefined),
            getMarkPrice: vi.fn().mockResolvedValue({ instId: "BTC-USDT-SWAP", markPx: "78000", ts: "1777279250000" }),
            placeOrder: vi.fn().mockResolvedValue({ ordId: "123", sCode: "0", sMsg: "" }),
            getOrder: vi.fn().mockResolvedValue({
                instId: "BTC-USDT-SWAP",
                ordId: "123",
                state: "filled",
                ordType: "market",
                side: "sell",
                sz: "190.24",
                accFillSz: "190.24",
                px: "",
                avgPx: "78195",
                cTime: "1777279250000",
                uTime: "1777279250000",
            }),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "isolated",
            positionMode: "net_mode",
        })

        await adapter.submitOrder({
            instrument: "BTC-USDT-SWAP",
            side: "sell",
            quantity: 1.9024,
            orderType: "market",
            timeInForce: "gtc",
            metadata: {
                action: "entry",
                leverage: 3,
                stopLoss: 78620,
                takeProfit: 77132.5,
            },
        })

        expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            attachAlgoOrds: [
                {
                    slTriggerPx: "78620",
                    slOrdPx: "-1",
                    tpTriggerPx: "77132.5",
                    tpOrdPx: "-1",
                },
            ],
        }))
    })

    it("uses OCO algo orders with contract size when refreshing protection after fill", async () => {
        const client = {
            getPositions: vi.fn().mockResolvedValue([
                {
                    instId: "BTC-USDT-SWAP",
                    instType: "SWAP",
                    posId: "pos-1",
                    pos: "-190.24",
                    posSide: "net",
                    avgPx: "78195",
                    markPx: "78050",
                    upl: "0",
                    lever: "3",
                    mgnMode: "isolated",
                },
            ]),
            getAlgoOrdersPending: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    {
                        algoId: "algo-1",
                        instId: "BTC-USDT-SWAP",
                        ordType: "oco",
                        side: "buy",
                        posSide: "net",
                    },
                ]),
            getInstruments: vi.fn().mockResolvedValue([btcInstrument]),
            placeAlgoOrder: vi.fn().mockResolvedValue({ algoId: "algo-1", sCode: "0", sMsg: "" }),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "isolated",
            positionMode: "net_mode",
        })

        const result = await adapter.updateProtectionOrders({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 78620,
            takeProfit: 77132.5,
        })

        expect(result.createdOrderIds).toEqual(["algo:BTC-USDT-SWAP:algo-1"])
        expect(client.placeAlgoOrder).toHaveBeenCalledWith({
            instId: "BTC-USDT-SWAP",
            tdMode: "isolated",
            side: "buy",
            posSide: "net",
            ordType: "oco",
            sz: "190.24",
            slTriggerPx: "78620",
            slOrdPx: "-1",
            tpTriggerPx: "77132.5",
            tpOrdPx: "-1",
        })
    })
})
