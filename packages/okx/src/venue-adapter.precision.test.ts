import { describe, expect, it, vi } from "vitest"
import { OKXVenueAdapter } from "./venue-adapter"
import { createOKXMarketContextLine } from "./market-context"

const dogeInstrument = {
    instId: "DOGE-USDT-SWAP",
    instType: "SWAP",
    state: "live",
    settleCcy: "USDT",
    ctVal: "1000",
    ctValCcy: "DOGE",
    ctMult: "1",
    lotSz: "0.01",
    minSz: "0.01",
    tickSz: "0.0000001",
}

const btcInstrument = {
    instId: "BTC-USDT-SWAP",
    instType: "SWAP",
    state: "live",
    settleCcy: "USDT",
    ctVal: "0.01",
    ctValCcy: "BTC",
    ctMult: "1",
    lotSz: "0.01",
    minSz: "0.01",
    tickSz: "0.1",
}

function createAdapter(instrument: Record<string, string>): OKXVenueAdapter {
    const client = {
        getInstruments: vi.fn().mockResolvedValue([instrument]),
    }

    return new OKXVenueAdapter(client as never, {
        marginMode: "isolated",
        positionMode: "net_mode",
    })
}

describe("OKXVenueAdapter sub-cent price precision", () => {
    it("preserves DOGE protective prices against a sub-microtick instrument", async () => {
        const adapter = createAdapter(dogeInstrument)

        expect(await adapter.normalizePrice("DOGE-USDT-SWAP", 0.06998)).toBe(0.06998)
        expect(await adapter.normalizePrice("DOGE-USDT-SWAP", 0.07125)).toBe(0.07125)
        expect(await adapter.normalizePrice("DOGE-USDT-SWAP", 0.0657)).toBe(0.0657)
    })

    it("rounds DOGE prices to the instrument tick instead of collapsing them", async () => {
        const adapter = createAdapter(dogeInstrument)

        expect(await adapter.normalizePrice("DOGE-USDT-SWAP", 0.071250004)).toBe(0.07125)
    })

    it("keeps BTC-scale tick rounding unchanged", async () => {
        const adapter = createAdapter(btcInstrument)

        expect(await adapter.normalizePrice("BTC-USDT-SWAP", 62000.5)).toBe(62000.5)
        expect(await adapter.normalizePrice("BTC-USDT-SWAP", 62000.57)).toBe(62000.6)
        expect(await adapter.normalizePrice("BTC-USDT-SWAP", 62000.02)).toBe(62000)
    })

    it("fails closed when a price cannot survive tick-size normalization", async () => {
        const adapter = createAdapter(btcInstrument)

        await expect(adapter.normalizePrice("BTC-USDT-SWAP", 0.04)).rejects.toThrow(
            "does not survive tick-size normalization"
        )
    })

    it("sizes DOGE contracts as nonzero lot-aligned quantities", async () => {
        const adapter = createAdapter(dogeInstrument)

        expect(await adapter.normalizeQuantity("DOGE-USDT-SWAP", 74627)).toEqual({
            contracts: 74.62,
            baseQuantity: 74620,
        })
        expect(await adapter.normalizeQuantity("DOGE-USDT-SWAP", 290)).toEqual({
            contracts: 0.29,
            baseQuantity: 290,
        })
    })

    it("reports sub-unit mark prices without truncating them to cents", () => {
        const line = createOKXMarketContextLine([
            {
                instrument: "DOGE-USDT-SWAP",
                bid: 0.06997,
                ask: 0.06999,
                markPrice: 0.06998,
                fundingRate: 0.0001,
                executionCost: {
                    metrics: {
                        app: "okx-swap",
                        instrument: "DOGE-USDT-SWAP",
                        instrumentClass: "perpetual_swap",
                        capturedAt: 0,
                        regimeKey: "okx-swap:weekday:asia",
                        nativeSpreadUnit: "price",
                        liquidityWarning: false,
                    },
                    status: "normal",
                    blockNewEntries: false,
                    summary: "",
                },
            },
        ])

        expect(line).toContain("mark 0.06998")
    })
})
