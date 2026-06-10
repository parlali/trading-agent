import { describe, expect, it, vi } from "vitest"
import type { OKXAccountBalance } from "./okx-client"
import { OKXVenueAdapter } from "./venue-adapter"
import { mapOKXExecutionResult } from "./venue-adapter-execution-results"

function createBalance(overrides: Partial<OKXAccountBalance> = {}): OKXAccountBalance {
    return {
        totalEq: "20500",
        upl: "500",
        availEq: "17000",
        details: [
            {
                ccy: "USDT",
                eq: "20500",
                availEq: "17000",
                cashBal: "20000",
            },
        ],
        ...overrides,
    }
}

function createSwapInstrument(instId: string, ctVal: string, ctValCcy: string) {
    return {
        instId,
        instType: "SWAP",
        state: "live",
        baseCcy: instId.split("-")[0],
        quoteCcy: "USDT",
        settleCcy: "USDT",
        ctVal,
        ctValCcy,
        lotSz: "0.01",
        minSz: "0.01",
        tickSz: "0.01",
    }
}

function createInstrumentRules(instId: string, contractValue: number, contractValueCurrency: string) {
    return {
        instId,
        instType: "SWAP",
        state: "live",
        tickSize: 0.01,
        lotSize: 0.01,
        minContracts: 0.01,
        contractValue,
        contractValueCurrency,
    }
}

describe("OKXVenueAdapter account snapshot semantics", () => {
    it("maps provider truth balance/equity/openPnl without labelling open PnL as day PnL", async () => {
        const client = {
            getBalance: vi.fn().mockResolvedValue(createBalance()),
            getPositions: vi.fn().mockResolvedValue([]),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        const account = await adapter.getAccountState()

        expect(account.equity).toBe(20500)
        expect(account.openPnl).toBe(500)
        expect(account.dayPnl).toBe(0)
        expect(account.balance).toBe(20000)
        expect(account.marginAvailable).toBe(17000)
    })

    it("fails closed to non-negative balance when provider upl is negative", async () => {
        const client = {
            getBalance: vi.fn().mockResolvedValue(createBalance({
                totalEq: "50",
                upl: "-100",
                availEq: "0",
                details: [],
            })),
            getPositions: vi.fn().mockResolvedValue([]),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const account = await adapter.getAccountState()

        expect(account.equity).toBe(50)
        expect(account.openPnl).toBe(-100)
        expect(account.dayPnl).toBe(0)
        expect(account.balance).toBe(150)
    })

    it("uses position-level provider truth when account-level upl and margin are zero", async () => {
        const client = {
            getBalance: vi.fn().mockResolvedValue(createBalance({
                upl: "0",
                imr: "0",
                mmr: "0",
            })),
            getPositions: vi.fn().mockResolvedValue([
                {
                    instId: "BTC-USDT-SWAP",
                    instType: "SWAP",
                    pos: "10",
                    posSide: "net",
                    avgPx: "80000",
                    markPx: "81000",
                    upl: "25.5",
                    imr: "300",
                    mgnMode: "cross",
                },
            ]),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const account = await adapter.getAccountState()

        expect(account.openPnl).toBe(25.5)
        expect(account.marginUsed).toBe(300)
        expect(account.dayPnl).toBe(0)
    })

    it("persists provider-reported entry fees from OKX order truth", async () => {
        const result = await mapOKXExecutionResult({
            instId: "BTC-USDT-SWAP",
            order: {
                instId: "BTC-USDT-SWAP",
                ordId: "9000000000000000001",
                clOrdId: "voke01abcdef2345",
                state: "filled",
                ordType: "market",
                side: "buy",
                sz: "50",
                accFillSz: "50",
                px: "",
                avgPx: "78000.125",
                reduceOnly: "false",
                fee: "-12.345678",
                feeCcy: "USDT",
                pnl: "0",
                tradeId: "7000000001",
                uTime: "1779027958553",
            },
            getInstrumentRules: async () => createInstrumentRules("BTC-USDT-SWAP", 0.01, "BTC"),
            contractsToBaseQuantity: (_rules, contracts) => contracts * 0.01,
        })

        expect(result).toMatchObject({
            providerOrderId: "order:BTC-USDT-SWAP:9000000000000000001",
            providerClientOrderId: "voke01abcdef2345",
            providerOrderAliases: expect.arrayContaining(["9000000000000000001", "voke01abcdef2345"]),
        })
        expect(result.intentUpdates?.metadata).toMatchObject({
            fee: -12.345678,
            feeCcy: "USDT",
            fillPnl: 0,
            providerAccountingSource: "okx_order",
            providerOrderId: "9000000000000000001",
            tradeId: "7000000001",
        })
    })

    it("does not persist reduce-only close fees on direct OKX close rows to avoid provider-close double counting", async () => {
        const result = await mapOKXExecutionResult({
            instId: "ETH-USDT-SWAP",
            order: {
                instId: "ETH-USDT-SWAP",
                ordId: "9000000000000000002",
                state: "filled",
                ordType: "market",
                side: "sell",
                sz: "110",
                accFillSz: "110",
                px: "",
                avgPx: "2180.5",
                reduceOnly: "true",
                fee: "-6.54321",
                feeCcy: "USDT",
                pnl: "-8.76543",
                tradeId: "7000000002",
                uTime: "1779038448537",
            },
            getInstrumentRules: async () => createInstrumentRules("ETH-USDT-SWAP", 0.1, "ETH"),
            contractsToBaseQuantity: (_rules, contracts) => contracts * 0.1,
        })

        expect(result.intentUpdates).toBeUndefined()
    })

    it("imports recent provider fill history as position closure truth", async () => {
        const client = {
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-1",
                    ordId: "ord-1",
                    side: "sell",
                    posSide: "long",
                    fillSz: "2",
                    fillPx: "3400",
                    fillPnl: "12.5",
                    fee: "-0.2",
                    feeCcy: "USDT",
                    ts: "1777279250000",
                },
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-2",
                    ordId: "ord-1",
                    side: "sell",
                    posSide: "long",
                    fillSz: "3",
                    fillPx: "3410",
                    fillPnl: "18.75",
                    fee: "-0.3",
                    feeCcy: "USDT",
                    ts: "1777279251000",
                },
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "entry-ignored",
                    ordId: "ord-entry",
                    side: "buy",
                    posSide: "long",
                    fillSz: "1",
                    fillPx: "3390",
                    ts: "1777279240000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        }
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(closures).toEqual([
            {
                instrument: "ETH-USDT-SWAP",
                side: "long",
                quantity: 0.5,
                fillPrice: 3406,
                closedAt: 1777279251000,
                metadata: {
                    orderId: "ord-1",
                    tradeIds: ["trade-1", "trade-2"],
                    side: "sell",
                    posSide: "long",
                    fillPnl: 31.25,
                    fee: -0.5,
                    feeCcy: "USDT",
                    source: "okx_fills_history",
                },
            },
        ])
    })

    it("excludes net-mode opening fills that report zero fillPnl and keeps canonical client ids on closures", async () => {
        const client = {
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-net-open",
                    ordId: "ord-net-open",
                    clOrdId: "voke01aaaaaaaaaa",
                    side: "sell",
                    posSide: "net",
                    fillSz: "2",
                    fillPx: "3400",
                    fillPnl: "0",
                    ts: "1777279250000",
                },
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-net-close",
                    ordId: "ord-net-close",
                    clOrdId: "vokc01aaaaaaaaaa",
                    side: "buy",
                    posSide: "net",
                    fillSz: "2",
                    fillPx: "3380",
                    fillPnl: "4",
                    ts: "1777279260000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        }
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(closures).toHaveLength(1)
        expect(closures[0]).toMatchObject({
            instrument: "ETH-USDT-SWAP",
            side: "short",
            quantity: 0.2,
            fillPrice: 3380,
            metadata: {
                orderId: "ord-net-close",
                clientOrderId: "vokc01aaaaaaaaaa",
                fillPnl: 4,
            },
        })
    })

    it("paginates fills history and fails closed when the bounded page budget is exceeded", async () => {
        const buildPage = (page: number) => Array.from({ length: 100 }, (_, index) => ({
            instId: "ETH-USDT-SWAP",
            tradeId: `trade-${page}-${index}`,
            ordId: `ord-${page}-${index}`,
            billId: `bill-${page}-${index}`,
            side: "sell",
            posSide: "long",
            fillSz: "1",
            fillPx: "3400",
            ts: "1777279250000",
        }))
        const exhaustedClient = {
            getFillsHistory: vi.fn().mockImplementation(async (_instType, params: { after?: string }) =>
                buildPage(params.after ? Number(params.after.split("-")[1]) + 1 : 0)
            ),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        }
        const exhaustedAdapter = new OKXVenueAdapter(exhaustedClient as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        await expect(exhaustedAdapter.getRecentPositionClosures()).rejects.toThrow("pagination exceeded")
        expect(exhaustedClient.getFillsHistory).toHaveBeenCalledTimes(10)

        const pagedClient = {
            getFillsHistory: vi.fn()
                .mockResolvedValueOnce(buildPage(0))
                .mockResolvedValueOnce(buildPage(1).slice(0, 5)),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        }
        const pagedAdapter = new OKXVenueAdapter(pagedClient as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        const closures = await pagedAdapter.getRecentPositionClosures()

        expect(pagedClient.getFillsHistory).toHaveBeenCalledTimes(2)
        expect(pagedClient.getFillsHistory.mock.calls[1]?.[1]).toMatchObject({
            after: "bill-0-99",
        })
        expect(closures).toHaveLength(105)
    })

    it("does not require fillPnl when position side proves an OKX fill is a close", async () => {
        const client = {
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "BTC-USDT-SWAP",
                    tradeId: "trade-close-without-pnl",
                    ordId: "ord-close-without-pnl",
                    side: "buy",
                    posSide: "short",
                    fillSz: "1",
                    fillPx: "80000",
                    fee: "-0.1",
                    feeCcy: "USDT",
                    ts: "1777279252000",
                },
                {
                    instId: "BTC-USDT-SWAP",
                    tradeId: "trade-open-ignored",
                    ordId: "ord-open-ignored",
                    side: "sell",
                    posSide: "short",
                    fillSz: "1",
                    fillPx: "80200",
                    ts: "1777279251000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("BTC-USDT-SWAP", "0.01", "BTC"),
            ]),
        }
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(closures).toEqual([
            {
                instrument: "BTC-USDT-SWAP",
                side: "short",
                quantity: 0.01,
                fillPrice: 80000,
                closedAt: 1777279252000,
                metadata: {
                    orderId: "ord-close-without-pnl",
                    tradeIds: ["trade-close-without-pnl"],
                    side: "buy",
                    posSide: "short",
                    fillPnl: undefined,
                    fee: -0.1,
                    feeCcy: "USDT",
                    source: "okx_fills_history",
                },
            },
        ])
    })
})
