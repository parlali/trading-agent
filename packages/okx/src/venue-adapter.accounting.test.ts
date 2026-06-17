import { describe, expect, it, vi } from "vitest"
import type { OKXAccountBalance } from "./okx-client"
import { OKX_ESTIMATED_ONE_WAY_FEE_RATE } from "./execution-fees"
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

function withOKXAccountingDefaults<T extends Record<string, unknown>>(client: T): T & {
    getAlgoOrdersHistory: ReturnType<typeof vi.fn>
    getAccountBills: ReturnType<typeof vi.fn>
} {
    return {
        getAlgoOrdersHistory: vi.fn().mockResolvedValue([]),
        getAccountBills: vi.fn().mockResolvedValue([]),
        ...client,
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

    it("uses settlement-currency equity instead of non-settlement account valuation", async () => {
        const client = {
            getBalance: vi.fn().mockResolvedValue(createBalance({
                totalEq: "20900.72742954619",
                upl: "",
                availEq: "",
                adjEq: "",
                details: [
                    {
                        ccy: "USDT",
                        eq: "8425.43689473387",
                        eqUsd: "8417.601238421768",
                        cashBal: "8425.43689473387",
                        availEq: "8425.43689473387",
                        availBal: "8425.43689473387",
                    },
                    {
                        ccy: "OKB",
                        eq: "100",
                        eqUsd: "7582.5",
                        cashBal: "100",
                        availEq: "100",
                        availBal: "100",
                    },
                    {
                        ccy: "AED",
                        eq: "18000",
                        eqUsd: "4900.626191124421",
                        cashBal: "18000",
                        availEq: "18000",
                        availBal: "18000",
                    },
                ],
            })),
            getPositions: vi.fn().mockResolvedValue([]),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "isolated",
            positionMode: "net_mode",
        })

        const account = await adapter.getAccountState()

        expect(account.equity).toBe(8425.43689473387)
        expect(account.balance).toBe(8425.43689473387)
        expect(account.buyingPower).toBe(8425.43689473387)
        expect(account.openPnl).toBe(0)
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
            providerAccountingOccurredAt: 1779027958553,
            providerOrderId: "9000000000000000001",
            tradeId: "7000000001",
        })
    })

    it("persists an explicit missing-accounting marker when OKX order truth has no parseable fee or pnl", async () => {
        const result = await mapOKXExecutionResult({
            instId: "BTC-USDT-SWAP",
            order: {
                instId: "BTC-USDT-SWAP",
                ordId: "9000000000000000003",
                clOrdId: "voke01missingacct",
                state: "filled",
                ordType: "market",
                side: "buy",
                sz: "50",
                accFillSz: "50",
                px: "",
                avgPx: "78000.125",
                reduceOnly: "false",
                fee: "",
                feeCcy: "USDT",
                pnl: "",
                tradeId: "7000000003",
                uTime: "1779027958553",
            },
            getInstrumentRules: async () => createInstrumentRules("BTC-USDT-SWAP", 0.01, "BTC"),
            contractsToBaseQuantity: (_rules, contracts) => contracts * 0.01,
        })

        expect(result.intentUpdates?.metadata).toMatchObject({
            providerAccountingSource: "okx_order",
            providerAccountingOccurredAt: 1779027958553,
            providerAccountingMissing: true,
            providerAccountingMissingReason: "okx_order_fee_and_pnl_unparseable",
            providerOrderId: "9000000000000000003",
            providerClientOrderId: "voke01missingacct",
            tradeId: "7000000003",
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
        const client = withOKXAccountingDefaults({
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
        })
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

    it("fails loud when one OKX close fill group has mixed fee currencies", async () => {
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-1",
                    ordId: "ord-1",
                    side: "sell",
                    posSide: "long",
                    fillSz: "1",
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
                    fillSz: "1",
                    fillPx: "3410",
                    fillPnl: "18.75",
                    fee: "-0.00001",
                    feeCcy: "ETH",
                    ts: "1777279260000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        await expect(adapter.getRecentPositionClosures()).rejects.toThrow("mixed fee currencies")
    })

    it("excludes net-mode opening fills and preserves zero-PnL canonical close accounting", async () => {
        const providerPositionId = "3618122936764637184"
        const client = withOKXAccountingDefaults({
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
                    posId: providerPositionId,
                    side: "buy",
                    posSide: "net",
                    fillSz: "2",
                    fillPx: "3380",
                    fillPnl: "0",
                    fee: "-0.12",
                    feeCcy: "USDT",
                    ts: "1777279260000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(closures).toHaveLength(1)
        expect(closures[0]).toMatchObject({
            instrument: "ETH-USDT-SWAP",
            providerPositionId,
            side: "short",
            quantity: 0.2,
            fillPrice: 3380,
            metadata: {
                orderId: "ord-net-close",
                clientOrderId: "vokc01aaaaaaaaaa",
                providerPositionId,
                providerPositionKey: `ETH-USDT-SWAP:${providerPositionId}`,
                posId: providerPositionId,
                fillPnl: 0,
                fee: -0.12,
                feeCcy: "USDT",
            },
        })
    })

    it("detects documented OKX close subtypes for zero-PnL net-mode fills", async () => {
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "BTC-USDT-SWAP",
                    tradeId: "trade-close-subtype",
                    ordId: "ord-close-subtype",
                    side: "sell",
                    posSide: "net",
                    fillSz: "3",
                    fillPx: "80000",
                    fillPnl: "0",
                    fee: "-0.1",
                    feeCcy: "USDT",
                    subType: "5",
                    ts: "1777279260000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("BTC-USDT-SWAP", "0.01", "BTC"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(closures).toHaveLength(1)
        expect(closures[0]).toMatchObject({
            instrument: "BTC-USDT-SWAP",
            side: "long",
            quantity: 0.03,
            fillPrice: 80000,
            metadata: {
                orderId: "ord-close-subtype",
                tradeIds: ["trade-close-subtype"],
                side: "sell",
                posSide: "net",
                subType: "5",
                fillPnl: 0,
                fee: -0.1,
                feeCcy: "USDT",
                source: "okx_fills_history",
            },
        })
    })

    it("fails loud when one OKX close fill group has mixed provider position ids", async () => {
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-pos-a",
                    ordId: "ord-net-close",
                    clOrdId: "vokc01aaaaaaaaaa",
                    posId: "pos-a",
                    side: "buy",
                    posSide: "net",
                    fillSz: "1",
                    fillPx: "3380",
                    fillPnl: "0",
                    ts: "1777279260000",
                },
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-pos-b",
                    ordId: "ord-net-close",
                    clOrdId: "vokc01aaaaaaaaaa",
                    posId: "pos-b",
                    side: "buy",
                    posSide: "net",
                    fillSz: "1",
                    fillPx: "3382",
                    fillPnl: "0",
                    ts: "1777279261000",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        await expect(adapter.getRecentPositionClosures()).rejects.toThrow("mixed provider position ids")
    })

    it("maps triggered OKX protection algo history onto closure aliases", async () => {
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "ETH-USDT-SWAP",
                    tradeId: "trade-protection-close",
                    ordId: "triggered-child-1",
                    side: "buy",
                    posSide: "net",
                    fillSz: "2",
                    fillPx: "3380",
                    fillPnl: "0",
                    fee: "-0.2",
                    feeCcy: "USDT",
                    ts: "1777279260000",
                },
            ]),
            getAlgoOrdersHistory: vi.fn().mockResolvedValue([
                {
                    algoId: "algo-parent-1",
                    algoClOrdId: "vokt01aaaaaaaaaa",
                    actualOrdId: "triggered-child-1",
                    instId: "ETH-USDT-SWAP",
                    ordType: "oco",
                    side: "buy",
                    posSide: "net",
                    state: "effective",
                },
            ]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(closures[0]?.metadata).toMatchObject({
            orderId: "triggered-child-1",
            triggeredOrderId: "triggered-child-1",
            algoId: "algo-parent-1",
            algoClOrdId: "vokt01aaaaaaaaaa",
            actualOrdId: "triggered-child-1",
            providerOrderAliases: expect.arrayContaining([
                "triggered-child-1",
                "algo-parent-1",
                "vokt01aaaaaaaaaa",
            ]),
            fillPnl: 0,
            fee: -0.2,
        })
    })

    it("enriches triggered OKX protection close identity from the actual child order", async () => {
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([
                {
                    instId: "BTC-USDT-SWAP",
                    tradeId: "trade-protection-child",
                    ordId: "triggered-child-2",
                    clOrdId: "Otriggeredchild2",
                    side: "buy",
                    posSide: "net",
                    fillSz: "5.24",
                    fillPx: "65755.1",
                    fillPnl: "7.06876",
                    fee: "-8.6139181",
                    feeCcy: "USDT",
                    ts: "1777279260000",
                },
            ]),
            getAlgoOrdersHistory: vi.fn().mockResolvedValue([]),
            getOrder: vi.fn().mockResolvedValue({
                instId: "BTC-USDT-SWAP",
                ordId: "triggered-child-2",
                clOrdId: "Otriggeredchild2",
                algoId: "algo-parent-2",
                algoClOrdId: "vokt01bbbbbbbbbb",
                state: "filled",
                ordType: "market",
                side: "buy",
                sz: "5.24",
                accFillSz: "5.24",
                px: "",
                avgPx: "65755.1",
            }),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("BTC-USDT-SWAP", "0.01", "BTC"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const closures = await adapter.getRecentPositionClosures()

        expect(client.getOrder).toHaveBeenCalledWith("BTC-USDT-SWAP", "triggered-child-2")
        expect(closures[0]?.metadata).toMatchObject({
            orderId: "triggered-child-2",
            clientOrderId: "Otriggeredchild2",
            triggeredOrderId: "triggered-child-2",
            algoId: "algo-parent-2",
            algoClOrdId: "vokt01bbbbbbbbbb",
            actualOrdId: "triggered-child-2",
            providerOrderAliases: expect.arrayContaining([
                "triggered-child-2",
                "Otriggeredchild2",
                "algo-parent-2",
                "vokt01bbbbbbbbbb",
            ]),
            fillPnl: 7.06876,
            fee: -8.6139181,
        })
    })

    it("ingests OKX funding bills as account PnL events", async () => {
        const client = withOKXAccountingDefaults({
            getAccountBills: vi.fn().mockResolvedValue([
                {
                    billId: "funding-bill-1",
                    instId: "BTC-USDT-SWAP",
                    ccy: "USDT",
                    amt: "-1.23",
                    type: "8",
                    subType: "173",
                    ts: "1777279260000",
                },
                {
                    billId: "trade-bill-ignored",
                    instId: "BTC-USDT-SWAP",
                    ccy: "USDT",
                    amt: "-0.2",
                    type: "2",
                    ts: "1777279260001",
                },
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        await expect(adapter.getAccountPnlEvents()).resolves.toEqual([
            {
                providerEventId: "funding-bill-1",
                eventType: "funding_fee",
                instrument: "BTC-USDT-SWAP",
                amount: -1.23,
                currency: "USDT",
                occurredAt: 1777279260000,
                metadata: {
                    source: "okx_account_bills",
                    billType: "8",
                    billSubType: "173",
                },
            },
        ])
    })

    it("fails loud when an OKX funding bill is denominated outside settlement currency", async () => {
        const client = withOKXAccountingDefaults({
            getAccountBills: vi.fn().mockResolvedValue([
                {
                    billId: "funding-bill-btc",
                    instId: "BTC-USD-SWAP",
                    ccy: "BTC",
                    amt: "-0.00001",
                    type: "8",
                    subType: "173",
                    ts: "1777279260000",
                },
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        await expect(adapter.getAccountPnlEvents()).rejects.toThrow("non-settlement currency BTC")
    })

    it("simulates OKX dry-run market fills from mark price with estimated settlement fees", async () => {
        const client = withOKXAccountingDefaults({
            getMarkPrice: vi.fn().mockResolvedValue({
                instId: "BTC-USDT-SWAP",
                markPx: "78000.127",
            }),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("BTC-USDT-SWAP", "0.01", "BTC"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const result = await adapter.simulateDryRunOrder({
            instrument: "BTC-USDT-SWAP",
            side: "buy",
            quantity: 0.5,
            orderType: "market",
            timeInForce: "gtc",
        }, {
            identity: {
                canonicalOrderId: "voke01dryrun0001",
                providerClientOrderId: "voke01dryrun0001",
                providerOrderId: "voke01dryrun0001",
                providerOrderAliases: [],
                submitAttemptId: "attempt-1",
                submitAttemptSequence: 1,
                commitOutcome: "accepted",
                venue: "okx-swap",
                role: "entry",
                sequence: 1,
            },
        })

        expect(result).toMatchObject({
            orderId: "voke01dryrun0001",
            status: "filled",
            filledQuantity: 0.5,
            fillPrice: 78000.13,
        })
        expect(result.intentUpdates?.metadata).toMatchObject({
            estimatedPrice: 78000.13,
            currentPrice: 78000.13,
            fee: expect.closeTo(-0.5 * 78000.13 * OKX_ESTIMATED_ONE_WAY_FEE_RATE),
            feeCcy: "USDT",
            providerAccountingSource: "okx_dry_run_simulator",
            providerFeeEstimated: true,
            dryRunEstimatedFeeRate: OKX_ESTIMATED_ONE_WAY_FEE_RATE,
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
        const exhaustedClient = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockImplementation(async (_instType, params: { after?: string }) =>
                buildPage(params.after ? Number(params.after.split("-")[1]) + 1 : 0)
            ),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
        const exhaustedAdapter = new OKXVenueAdapter(exhaustedClient as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        await expect(exhaustedAdapter.getRecentPositionClosures()).rejects.toThrow("pagination exceeded")
        expect(exhaustedClient.getFillsHistory).toHaveBeenCalledTimes(10)

        const pagedClient = withOKXAccountingDefaults({
            getFillsHistory: vi.fn()
                .mockResolvedValueOnce(buildPage(0))
                .mockResolvedValueOnce(buildPage(1).slice(0, 5)),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
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

    it("throws loud when a full fills page lacks a pagination cursor instead of silently truncating", async () => {
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({
                instId: "ETH-USDT-SWAP",
                tradeId: `trade-${index}`,
                ordId: `ord-${index}`,
                side: "sell",
                posSide: "long",
                fillSz: "1",
                fillPx: "3400",
                ts: "1777279250000",
            }))),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        await expect(adapter.getRecentPositionClosures()).rejects.toThrow("without a pagination cursor")
        expect(client.getFillsHistory).toHaveBeenCalledTimes(1)
    })

    it("paginates account bills, concatenates pages, and stops on a short page", async () => {
        const recentTs = String(Date.now())
        const buildBillsPage = (page: number, length: number) => Array.from({ length }, (_, index) => ({
            billId: `bill-${page}-${index}`,
            instId: "BTC-USDT-SWAP",
            ccy: "USDT",
            amt: "-0.01",
            type: "8",
            subType: "173",
            ts: recentTs,
        }))
        const client = withOKXAccountingDefaults({
            getAccountBills: vi.fn()
                .mockResolvedValueOnce(buildBillsPage(0, 100))
                .mockResolvedValueOnce(buildBillsPage(1, 5)),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const events = await adapter.getAccountPnlEvents()

        expect(events).toHaveLength(105)
        expect(client.getAccountBills).toHaveBeenCalledTimes(2)
        expect(client.getAccountBills.mock.calls[1]?.[0]).toMatchObject({
            after: "bill-0-99",
        })
    })

    it("stops paginating account bills once entries fall behind the lookback begin bound", async () => {
        const staleTs = String(Date.now() - 48 * 60 * 60 * 1000)
        const client = withOKXAccountingDefaults({
            getAccountBills: vi.fn().mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({
                billId: `bill-stale-${index}`,
                instId: "BTC-USDT-SWAP",
                ccy: "USDT",
                amt: "-0.01",
                type: "8",
                subType: "173",
                ts: staleTs,
            }))),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const events = await adapter.getAccountPnlEvents()

        expect(events).toHaveLength(100)
        expect(client.getAccountBills).toHaveBeenCalledTimes(1)
    })

    it("fails closed when account bills pagination exceeds the bounded page budget", async () => {
        const recentTs = String(Date.now())
        const client = withOKXAccountingDefaults({
            getAccountBills: vi.fn().mockImplementation(async (params: { after?: string }) => {
                const page = params.after ? Number(params.after.split("-")[1]) + 1 : 0
                return Array.from({ length: 100 }, (_, index) => ({
                    billId: `bill-${page}-${index}`,
                    instId: "BTC-USDT-SWAP",
                    ccy: "USDT",
                    amt: "-0.01",
                    type: "8",
                    subType: "173",
                    ts: recentTs,
                }))
            }),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        await expect(adapter.getAccountPnlEvents()).rejects.toThrow("pagination exceeded")
        expect(client.getAccountBills).toHaveBeenCalledTimes(10)
    })

    it("paginates algo-order history per ordType and state, sending OKX's required state filter", async () => {
        const recentCTime = String(Date.now())
        const buildAlgoPage = (ordType: string, state: string, page: number, length: number) => Array.from({ length }, (_, index) => ({
            algoId: `algo-${ordType}-${state}-${page}-${index}`,
            instId: "ETH-USDT-SWAP",
            ordType,
            side: "buy",
            posSide: "net",
            state,
            cTime: recentCTime,
        }))
        const pagesByKey = new Map<string, ReturnType<typeof buildAlgoPage>[]>([
            ["conditional:effective", [
                buildAlgoPage("conditional", "effective", 0, 100),
                buildAlgoPage("conditional", "effective", 1, 3),
            ]],
            ["conditional:canceled", []],
            ["conditional:order_failed", []],
            ["oco:effective", [
                buildAlgoPage("oco", "effective", 0, 2),
            ]],
            ["oco:canceled", []],
            ["oco:order_failed", []],
        ])
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
            getAlgoOrdersHistory: vi.fn().mockImplementation(async (params: { ordType: string, state: string }) => {
                const pages = pagesByKey.get(`${params.ordType}:${params.state}`)
                if (!pages) {
                    throw new Error(`unexpected ${params.ordType}/${params.state} request`)
                }
                const next = pages.shift()
                return next ?? []
            }),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        await adapter.getRecentPositionClosures()

        expect(client.getAlgoOrdersHistory).toHaveBeenCalledTimes(7)
        expect(client.getAlgoOrdersHistory.mock.calls.every((call) => {
            const params = call[0] as { state?: string }
            return params.state === "effective" || params.state === "canceled" || params.state === "order_failed"
        })).toBe(true)
        const conditionalCalls = client.getAlgoOrdersHistory.mock.calls
            .map((call) => call[0] as { ordType: string, state: string, after?: string })
            .filter((params) => params.ordType === "conditional" && params.state === "effective")
        expect(conditionalCalls).toHaveLength(2)
        expect(conditionalCalls[1]).toMatchObject({
            after: "algo-conditional-effective-0-99",
        })
    })

    it("fails closed when algo-order history pagination exceeds the bounded page budget", async () => {
        const recentCTime = String(Date.now())
        const client = withOKXAccountingDefaults({
            getFillsHistory: vi.fn().mockResolvedValue([]),
            getInstruments: vi.fn().mockResolvedValue([
                createSwapInstrument("ETH-USDT-SWAP", "0.1", "ETH"),
            ]),
            getAlgoOrdersHistory: vi.fn().mockImplementation(async (params: { ordType: string, after?: string }) => {
                const page = params.after ? Number(params.after.split("-")[2]) + 1 : 0
                return Array.from({ length: 100 }, (_, index) => ({
                    algoId: `algo-${params.ordType}-${page}-${index}`,
                    instId: "ETH-USDT-SWAP",
                    ordType: params.ordType,
                    side: "buy",
                    posSide: "net",
                    state: "effective",
                    cTime: recentCTime,
                }))
            }),
        })
        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        await expect(adapter.getRecentPositionClosures()).rejects.toThrow("pagination exceeded")
    })

    it("does not require fillPnl when position side proves an OKX fill is a close", async () => {
        const client = withOKXAccountingDefaults({
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
        })
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
