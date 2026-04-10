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

describe("PolymarketClient.searchMarkets", () => {
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
