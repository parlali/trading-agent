import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PolymarketClient } from "./polymarket-client.ts"

function createClient(): PolymarketClient {
    return new PolymarketClient({
        privateKey: "0x" + "01".repeat(32),
        apiKey: "api-key",
        apiSecret: Buffer.from("secret").toString("base64"),
        apiPassphrase: "passphrase",
        funderAddress: "0x1111111111111111111111111111111111111111",
    })
}

function createJsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
    })
}

function createStatusResponse(status: number, statusText: string = ""): Response {
    return new Response("", { status, statusText })
}

describe("PolymarketClient public read paths", () => {
    const fetchMock = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("uses documented public-search parameters to bound the remote query path", async () => {
        fetchMock.mockResolvedValue(
            createJsonResponse({
                events: [
                    {
                        title: "2028 Election",
                        category: "Politics",
                        markets: [
                            {
                                conditionId: "condition-1",
                                questionID: "question-1",
                                question: "Will candidate A win?",
                                description: "Election market",
                                outcomes: "[\"Yes\",\"No\"]",
                                clobTokenIds: "[\"token-yes\",\"token-no\"]",
                                active: true,
                                closed: false,
                                orderMinSize: 5,
                                orderPriceMinTickSize: 0.01,
                                liquidityNum: 1000,
                                volumeNum: 2000,
                                endDateIso: "2028-11-07T00:00:00Z",
                                slug: "candidate-a-win",
                            },
                        ],
                    },
                ],
            })
        )

        const results = await createClient().searchMarkets("candidate A", 3)

        expect(results).toHaveLength(1)
        expect(fetchMock).toHaveBeenCalledTimes(1)

        const [requestUrl] = fetchMock.mock.calls[0] ?? []
        expect(typeof requestUrl).toBe("string")

        const url = new URL(String(requestUrl))
        expect(url.origin).toBe("https://gamma-api.polymarket.com")
        expect(url.pathname).toBe("/public-search")
        expect(url.searchParams.get("q")).toBe("candidate A")
        expect(url.searchParams.get("limit_per_type")).toBe("9")
        expect(url.searchParams.get("page")).toBe("1")
        expect(url.searchParams.get("search_tags")).toBe("false")
        expect(url.searchParams.get("search_profiles")).toBe("false")
        expect(url.searchParams.get("optimized")).toBe("true")
        expect(url.searchParams.get("limit")).toBeNull()
    })

    it("treats public-search and slug lookup 404s as empty reads", async () => {
        fetchMock
            .mockResolvedValueOnce(createStatusResponse(404, "Not Found"))
            .mockResolvedValueOnce(createJsonResponse([]))
            .mockResolvedValueOnce(createJsonResponse([]))

        const results = await createClient().searchMarkets("missing market slug", 3)

        expect(results).toEqual([])
        expect(fetchMock).toHaveBeenCalledTimes(3)

        fetchMock.mockReset()
        fetchMock
            .mockResolvedValueOnce(createStatusResponse(404, "Not Found"))
            .mockResolvedValueOnce(createStatusResponse(404, "Not Found"))

        const market = await createClient().getMarketBySlug("missing-market")

        expect(market).toBeNull()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})

describe("PolymarketClient.getMarketBySlug", () => {
    const fetchMock = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("resolves slug lookups through event fallback and direct URL normalization", async () => {
        fetchMock
            .mockResolvedValueOnce(createJsonResponse([]))
            .mockResolvedValueOnce(createJsonResponse([
                {
                    title: "Synthetic service interruption",
                    category: "Politics",
                    markets: [
                        {
                            conditionId: "condition-dhs",
                            questionID: "question-dhs",
                            question: "How long will the synthetic service interruption last?",
                            description: "Synthetic interruption market",
                            outcomes: "[\"Before May\",\"After May\"]",
                            clobTokenIds: "[\"token-before\",\"token-after\"]",
                            active: true,
                            closed: false,
                            orderMinSize: 5,
                            orderPriceMinTickSize: 0.01,
                            liquidityNum: 5000,
                            volumeNum: 8000,
                            endDateIso: "2026-05-01T00:00:00Z",
                            slug: "how-long-will-the-dhs-shutdown-last",
                        },
                    ],
                },
            ]))

        const result = await createClient().getMarketBySlug("dhs-shutdown")

        expect(result?.conditionId).toBe("condition-dhs")
        expect(fetchMock).toHaveBeenCalledTimes(2)

        const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
        const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
        expect(firstUrl.pathname).toBe("/markets")
        expect(secondUrl.pathname).toBe("/events")
        expect(secondUrl.searchParams.get("slug")).toBe("dhs-shutdown")
        expect(secondUrl.searchParams.get("limit")).toBe("1")

        fetchMock.mockReset()
        fetchMock.mockResolvedValueOnce(createJsonResponse([
            {
                conditionId: "condition-url",
                questionID: "question-url",
                question: "Will the URL market resolve yes?",
                description: "URL market",
                outcomes: "[\"Yes\",\"No\"]",
                clobTokenIds: "[\"token-url-yes\",\"token-url-no\"]",
                active: true,
                closed: false,
                orderMinSize: 5,
                orderPriceMinTickSize: 0.01,
                liquidityNum: 5000,
                volumeNum: 8000,
                endDateIso: "2026-05-01T00:00:00Z",
                slug: "will-the-url-market-resolve-yes",
            },
        ]))

        const urlResult = await createClient().getMarketBySlug("https://polymarket.com/event/will-the-url-market-resolve-yes?tid=123")

        expect(urlResult?.conditionId).toBe("condition-url")
        expect(fetchMock).toHaveBeenCalledTimes(1)

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
        expect(url.pathname).toBe("/markets")
        expect(url.searchParams.get("slug")).toBe("will-the-url-market-resolve-yes")
    })
})

describe("PolymarketClient.getCurrentPositions", () => {
    const fetchMock = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("uses the Polymarket data API positions endpoint with the configured funder address", async () => {
        fetchMock.mockResolvedValue(createJsonResponse([]))

        await createClient().getCurrentPositions()

        expect(fetchMock).toHaveBeenCalledTimes(1)

        const [requestUrl] = fetchMock.mock.calls[0] ?? []
        expect(typeof requestUrl).toBe("string")

        const url = new URL(String(requestUrl))
        expect(url.origin).toBe("https://data-api.polymarket.com")
        expect(url.pathname).toBe("/positions")
        expect(url.searchParams.get("user")).toBe("0x1111111111111111111111111111111111111111")
    })
})

describe("PolymarketClient.prepareOrder", () => {
    const fetchMock = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("carries the provider fee rate into the signed order and its metadata", async () => {
        fetchMock.mockImplementation(async (input) => {
            const url = new URL(String(input))
            if (url.pathname === "/tick-size") {
                return createJsonResponse({ minimum_tick_size: "0.01" })
            }
            if (url.pathname === "/fee-rate") {
                return createJsonResponse({ fee_rate_bps: "20" })
            }
            return createStatusResponse(404)
        })

        const prepared = await createClient().prepareOrder({
            tokenId: "123456",
            canonicalOrderId: "vpmc01entry1234",
            side: "buy",
            size: 10,
            price: 0.42,
            orderType: "GTC",
            negRisk: false,
        })

        expect((prepared.orderBody.order as Record<string, unknown>).feeRateBps).toBe("20")
        expect(prepared.signedOrderMetadata.feeRateBps).toBe(20)
    })
})
