import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AlpacaClient } from "./alpaca-client"
import { resolveAlpacaRuntimeConfig } from "./runtime-config"

describe("resolveAlpacaRuntimeConfig", () => {
    it("derives paper hosts from the explicit environment", () => {
        const config = resolveAlpacaRuntimeConfig({
            ALPACA_API_KEY: "paper-key",
            ALPACA_SECRET_KEY: "paper-secret",
            ALPACA_ENVIRONMENT: "paper",
            ALPACA_ACCOUNT_ID: "paper-account",
        })

        expect(config.environment).toBe("paper")
        expect(config.tradingBaseUrl).toBe("https://paper-api.alpaca.markets")
        expect(config.marketDataBaseUrl).toBe("https://data.alpaca.markets")
        expect(config.credentials).toEqual({
            apiKey: "paper-key",
            secretKey: "paper-secret",
            accountId: "paper-account",
        })
    })

    it("derives live hosts from the explicit environment", () => {
        const config = resolveAlpacaRuntimeConfig({
            ALPACA_API_KEY: "live-key",
            ALPACA_SECRET_KEY: "live-secret",
            ALPACA_ENVIRONMENT: "live",
            ALPACA_ACCOUNT_ID: null,
        })

        expect(config.environment).toBe("live")
        expect(config.tradingBaseUrl).toBe("https://api.alpaca.markets")
        expect(config.marketDataBaseUrl).toBe("https://data.alpaca.markets")
        expect(config.credentials.accountId).toBe("")
    })

    it("rejects unsupported Alpaca environments", () => {
        expect(() => resolveAlpacaRuntimeConfig({
            ALPACA_API_KEY: "key",
            ALPACA_SECRET_KEY: "secret",
            ALPACA_ENVIRONMENT: "sandbox",
            ALPACA_ACCOUNT_ID: null,
        })).toThrow('Set ALPACA_ENVIRONMENT to "paper" or "live"')
    })
})

describe("AlpacaClient host routing", () => {
    const fetchMock = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("uses the trading host for option contract discovery", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ option_contracts: [] }), {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
            })
        )

        const client = new AlpacaClient(resolveAlpacaRuntimeConfig({
            ALPACA_API_KEY: "key",
            ALPACA_SECRET_KEY: "secret",
            ALPACA_ENVIRONMENT: "paper",
            ALPACA_ACCOUNT_ID: null,
        }))

        await client.getOptionContracts({
            underlyingSymbol: "spy",
            expirationDate: "2026-04-17",
        })

        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            "https://paper-api.alpaca.markets/v2/options/contracts?"
        )
    })

    it("uses the market-data host for equity quotes", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({
                quote: {
                    bp: 510.1,
                    ap: 510.2,
                    bs: 1,
                    as: 2,
                    t: "2026-04-09T12:00:00Z",
                },
            }), {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
            })
        )

        const client = new AlpacaClient(resolveAlpacaRuntimeConfig({
            ALPACA_API_KEY: "key",
            ALPACA_SECRET_KEY: "secret",
            ALPACA_ENVIRONMENT: "live",
            ALPACA_ACCOUNT_ID: null,
        }))

        await client.getLatestEquityQuote("SPY")

        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            "https://data.alpaca.markets/v2/stocks/SPY/quotes/latest"
        )
    })
})
