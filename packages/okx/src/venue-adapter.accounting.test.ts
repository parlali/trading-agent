import { describe, expect, it, vi } from "vitest"
import type { OKXAccountBalance } from "./okx-client"
import { OKXVenueAdapter } from "./venue-adapter"

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
