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
                clOrdId: "voke01abcdef2345",
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
        }, {
            identity: {
                canonicalOrderId: "voke01abcdef2345",
                providerClientOrderId: "voke01abcdef2345",
                providerOrderAliases: [],
                submitAttemptId: "attempt",
                submitAttemptSequence: 1,
                commitOutcome: "accepted",
                venue: "okx-swap",
                role: "entry",
                sequence: 1,
            },
        })

        expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            clOrdId: "voke01abcdef2345",
            attachAlgoOrds: [
                {
                    attachAlgoClOrdId: expect.stringMatching(/^vokt01[a-z2-7]{10}$/),
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
        const identity = createProtectionIdentity()

        const result = await adapter.updateProtectionOrders({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 78620,
            takeProfit: 77132.5,
            identity,
        })

        expect(result.createdOrderIds).toEqual(["algo:BTC-USDT-SWAP:algo-1"])
        expect(client.placeAlgoOrder).toHaveBeenCalledWith({
            instId: "BTC-USDT-SWAP",
            tdMode: "isolated",
            side: "buy",
            posSide: "net",
            ordType: "oco",
            sz: "190.24",
            algoClOrdId: expect.stringMatching(/^vokt01[a-z2-7]{10}$/),
            slTriggerPx: "78620",
            slOrdPx: "-1",
            tpTriggerPx: "77132.5",
            tpOrdPx: "-1",
        })
    })

    it("normalizes protection size to OKX lot precision when provider quantity has floating point residue", async () => {
        const client = {
            getPositions: vi.fn().mockResolvedValue([
                {
                    instId: "BTC-USDT-SWAP",
                    instType: "SWAP",
                    posId: "pos-1",
                    pos: "-3.67",
                    posSide: "net",
                    avgPx: "60144",
                    markPx: "60165",
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

        await adapter.updateProtectionOrders({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 60385,
            takeProfit: 59920,
            identity: createProtectionIdentity(),
        })

        expect(client.placeAlgoOrder).toHaveBeenCalledWith(expect.objectContaining({
            sz: "3.67",
        }))
    })

    it("derives stable child identities for standalone stop-only, take-profit-only, and combined protection", async () => {
        const identity = createProtectionIdentity()
        const cases = [
            {
                args: { stopLoss: 78620 },
                expectedRole: "s",
                expectedOrderType: "conditional",
            },
            {
                args: { takeProfit: 77132.5 },
                expectedRole: "t",
                expectedOrderType: "conditional",
            },
            {
                args: { stopLoss: 78620, takeProfit: 77132.5 },
                expectedRole: "t",
                expectedOrderType: "oco",
            },
        ]
        const childIds: string[] = []

        for (const entry of cases) {
            const client = createProtectionClient()
            const adapter = new OKXVenueAdapter(client as never, {
                marginMode: "isolated",
                positionMode: "net_mode",
            })

            await adapter.updateProtectionOrders({
                instrument: "BTC-USDT-SWAP",
                ...entry.args,
                identity,
            })

            const request = client.placeAlgoOrder.mock.calls[0]?.[0]
            expect(request).toBeDefined()
            if (!request) {
                throw new Error("Expected OKX protection order request")
            }
            const childId = request.algoClOrdId
            expect(request).toMatchObject({
                ordType: entry.expectedOrderType,
                algoClOrdId: expect.stringMatching(new RegExp(`^vok${entry.expectedRole}01[a-z2-7]{10}$`)),
            })
            childIds.push(childId)
        }

        expect(childIds[0]).not.toBe(childIds[1])
        expect(childIds[1]).toBe(childIds[2])
    })

    it("maps protection algo client ids into typed working-order identity fields", async () => {
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
            getOrdersPending: vi.fn().mockResolvedValue([]),
            getAlgoOrdersPending: vi.fn().mockResolvedValue([
                {
                    algoId: "algo-1",
                    algoClOrdId: "vokt01abcde23456",
                    instId: "BTC-USDT-SWAP",
                    ordType: "oco",
                    state: "live",
                    side: "buy",
                    posSide: "net",
                    cTime: "1777279250000",
                    uTime: "1777279250000",
                    slTriggerPx: "78620",
                    tpTriggerPx: "77132.5",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([btcInstrument]),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "isolated",
            positionMode: "net_mode",
        })

        const [order] = await adapter.getWorkingOrders()

        expect(order).toMatchObject({
            orderId: "algo:BTC-USDT-SWAP:algo-1",
            providerOrderId: "algo:BTC-USDT-SWAP:algo-1",
            providerClientOrderId: "vokt01abcde23456",
            providerOrderAliases: ["algo-1", "vokt01abcde23456"],
        })
    })

    it("fails closed when created protection does not appear in pending algo truth", async () => {
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
            getAlgoOrdersPending: vi.fn().mockResolvedValue([]),
            getInstruments: vi.fn().mockResolvedValue([btcInstrument]),
            placeAlgoOrder: vi.fn().mockResolvedValue({ algoId: "algo-missing", sCode: "0", sMsg: "" }),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "isolated",
            positionMode: "net_mode",
        })

        await expect(adapter.updateProtectionOrders({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 78620,
            takeProfit: 77132.5,
            identity: createProtectionIdentity(),
        })).rejects.toThrow("did not appear in pending algo orders")
    })

    it("fails closed before live OKX mutation when standalone protection has no canonical identity", async () => {
        const client = createProtectionClient()
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "isolated",
            positionMode: "net_mode",
        })

        await expect(adapter.updateProtectionOrders({
            instrument: "BTC-USDT-SWAP",
            stopLoss: 78620,
        } as never)).rejects.toThrow("requires canonical execution identity")

        expect(client.getPositions).not.toHaveBeenCalled()
        expect(client.placeAlgoOrder).not.toHaveBeenCalled()
    })
})

function createProtectionIdentity() {
    return {
        canonicalOrderId: "vokm01abcdef2345",
        providerClientOrderId: "vokm01abcdef2345",
        providerOrderAliases: [],
        submitAttemptId: "attempt",
        submitAttemptSequence: 1,
        commitOutcome: "accepted" as const,
        venue: "okx-swap" as const,
        role: "modify" as const,
        sequence: 1,
    }
}

function createProtectionClient() {
    return {
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
        cancelAlgoOrders: vi.fn().mockResolvedValue([]),
        placeAlgoOrder: vi.fn().mockResolvedValue({ algoId: "algo-1", sCode: "0", sMsg: "" }),
    }
}
