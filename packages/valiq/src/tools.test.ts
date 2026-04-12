import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ValiqDataClient } from "./client.ts"
import { ValiqDataAdapter } from "./data.ts"
import { createValiqBreakingNewsTool, createValiqDataTool } from "./tools.ts"
import type { BreakingNewsResponse } from "./types.ts"

const MOCK_BREAKING_NEWS: BreakingNewsResponse = {
    articles: [
        {
            time: "2026-04-01T12:00:00Z",
            title: "Fed Holds Rates Steady",
            description: "The Federal Reserve maintained its benchmark rate.",
            publisher: "Reuters",
            url: "https://example.com/fed",
            sentiment_finbert: 0.12,
            confidence_finbert: 0.87,
        },
    ],
    summary: {
        window: "24h",
        total_count: 1,
        avg_sentiment_finbert: 0.12,
        by_source: [
            { source: "general", count: 1, avg_sentiment_finbert: 0.12 },
        ],
    },
}

function getMockRequest(client: ValiqDataClient): ReturnType<typeof vi.fn> {
    return client.request as unknown as ReturnType<typeof vi.fn>
}

describe("createValiqBreakingNewsTool", () => {
    let mockClient: ValiqDataClient
    let adapter: ValiqDataAdapter

    beforeEach(() => {
        mockClient = {
            request: vi.fn(),
        } as unknown as ValiqDataClient

        adapter = new ValiqDataAdapter(mockClient)
    })

    it("has correct tool metadata", () => {
        const tool = createValiqBreakingNewsTool(adapter)

        expect(tool.name).toBe("get_breaking_news")
        expect(tool.description).toContain("breaking news")
        expect(tool.jsonSchema).toBeDefined()
        expect(tool.jsonSchema?.properties).toHaveProperty("window")
        expect(tool.jsonSchema?.properties).toHaveProperty("source")
    })

    it("calls the breaking news endpoint with no params", async () => {
        getMockRequest(mockClient).mockResolvedValue(MOCK_BREAKING_NEWS)

        const tool = createValiqBreakingNewsTool(adapter)
        const result = await tool.handler({})

        expect(mockClient.request).toHaveBeenCalledWith("/breaking-news")
        expect(result).toEqual(MOCK_BREAKING_NEWS)
    })

    it("passes window parameter to the endpoint", async () => {
        getMockRequest(mockClient).mockResolvedValue(MOCK_BREAKING_NEWS)

        const tool = createValiqBreakingNewsTool(adapter)
        await tool.handler({ window: "1h" })

        expect(mockClient.request).toHaveBeenCalledWith("/breaking-news?window=1h")
    })

    it("passes source parameter to the endpoint", async () => {
        getMockRequest(mockClient).mockResolvedValue(MOCK_BREAKING_NEWS)

        const tool = createValiqBreakingNewsTool(adapter)
        await tool.handler({ source: "crypto" })

        expect(mockClient.request).toHaveBeenCalledWith("/breaking-news?source=crypto")
    })

    it("passes both parameters to the endpoint", async () => {
        getMockRequest(mockClient).mockResolvedValue(MOCK_BREAKING_NEWS)

        const tool = createValiqBreakingNewsTool(adapter)
        await tool.handler({ window: "7d", source: "general" })

        const call = getMockRequest(mockClient).mock.calls[0]![0] as string
        expect(call).toContain("window=7d")
        expect(call).toContain("source=general")
    })

    it("validates parameters with zod schema", () => {
        const tool = createValiqBreakingNewsTool(adapter)

        expect(tool.parameters.safeParse({}).success).toBe(true)
        expect(tool.parameters.safeParse({ window: "1h" }).success).toBe(true)
        expect(tool.parameters.safeParse({ window: "invalid" }).success).toBe(false)
        expect(tool.parameters.safeParse({ source: "general" }).success).toBe(true)
        expect(tool.parameters.safeParse({ source: "fmp-general" }).success).toBe(false)
        expect(tool.parameters.safeParse({ source: "invalid" }).success).toBe(false)
    })

    it("propagates API errors", async () => {
        getMockRequest(mockClient).mockRejectedValue(
            new Error("Val-iQ Data API error: 500 Internal Server Error")
        )

        const tool = createValiqBreakingNewsTool(adapter)
        await expect(tool.handler({})).rejects.toThrow("Val-iQ Data API error")
    })
})

describe("createValiqDataTool", () => {
    let mockClient: ValiqDataClient
    let adapter: ValiqDataAdapter

    beforeEach(() => {
        mockClient = {
            request: vi.fn(),
        } as unknown as ValiqDataClient

        adapter = new ValiqDataAdapter(mockClient)
    })

    it("has correct tool metadata", () => {
        const tool = createValiqDataTool(adapter)

        expect(tool.name).toBe("query_valiq_data")
        expect(tool.description).toContain("data endpoints")
        expect(tool.jsonSchema?.required).toContain("endpoint")
    })

    it("routes getBreakingNews endpoint", async () => {
        getMockRequest(mockClient).mockResolvedValue(MOCK_BREAKING_NEWS)

        const tool = createValiqDataTool(adapter)
        await tool.handler({ endpoint: "getBreakingNews" })

        expect(mockClient.request).toHaveBeenCalledWith("/breaking-news")
    })

    it("requires ticker for equity endpoints", async () => {
        const tool = createValiqDataTool(adapter)

        await expect(tool.handler({ endpoint: "getEquityOverview" })).rejects.toThrow(
            "ticker is required"
        )
    })

    it("requires region for macro endpoints", async () => {
        const tool = createValiqDataTool(adapter)

        await expect(tool.handler({ endpoint: "getMacroEconomy" })).rejects.toThrow(
            "region is required"
        )
    })

    it("validates endpoint parameter", () => {
        const tool = createValiqDataTool(adapter)

        expect(tool.parameters.safeParse({ endpoint: "getBreakingNews" }).success).toBe(true)
        expect(tool.parameters.safeParse({ endpoint: "getCurrentPrice" }).success).toBe(false)
        expect(tool.parameters.safeParse({ endpoint: "getEquityPrice" }).success).toBe(false)
        expect(tool.parameters.safeParse({ endpoint: "getOptionsChain" }).success).toBe(false)
        expect(tool.parameters.safeParse({ endpoint: "getOptionsIV" }).success).toBe(false)
        expect(tool.parameters.safeParse({ endpoint: "screenOptions" }).success).toBe(false)
        expect(tool.parameters.safeParse({ endpoint: "nonExistent" }).success).toBe(false)
        expect(tool.parameters.safeParse({}).success).toBe(false)
    })
})

describe("ValiqDataClient", () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("sends X-API-Key header", async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ articles: [], summary: {} }),
        })
        globalThis.fetch = fetchSpy as typeof fetch

        const client = new ValiqDataClient({
            apiUrl: "https://data.example.com",
            apiKey: "test-key-123",
        })

        await client.request("/breaking-news")

        expect(fetchSpy).toHaveBeenCalledWith(
            "https://data.example.com/breaking-news",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "X-API-Key": "test-key-123",
                }),
            })
        )
    })

    it("throws on non-ok responses", async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: () => Promise.resolve("Invalid API key"),
        })
        globalThis.fetch = fetchSpy as typeof fetch

        const client = new ValiqDataClient({
            apiUrl: "https://data.example.com",
            apiKey: "bad-key",
        })

        await expect(client.request("/breaking-news")).rejects.toThrow("401")
    })
})

describe("tool registration chain", () => {
    it("polymarket plugin returns empty tools when secrets missing", () => {
        const getExtraTools = (secrets: Record<string, string | null>) => {
            const dataApiUrl = secrets.VALIQ_DATA_API_URL
            const dataApiKey = secrets.VALIQ_DATA_API

            if (!dataApiUrl || !dataApiKey) {
                return []
            }

            const client = new ValiqDataClient({
                apiUrl: dataApiUrl,
                apiKey: dataApiKey,
            })
            const data = new ValiqDataAdapter(client)
            return [createValiqBreakingNewsTool(data)]
        }

        expect(getExtraTools({})).toEqual([])
        expect(getExtraTools({ VALIQ_DATA_API_URL: null, VALIQ_DATA_API: null })).toEqual([])
        expect(getExtraTools({ VALIQ_DATA_API_URL: "https://api.example.com", VALIQ_DATA_API: null })).toEqual([])
        expect(getExtraTools({ VALIQ_DATA_API_URL: null, VALIQ_DATA_API: "key-123" })).toEqual([])
    })

    it("polymarket plugin returns breaking news tool when secrets present", () => {
        const getExtraTools = (secrets: Record<string, string | null>) => {
            const dataApiUrl = secrets.VALIQ_DATA_API_URL
            const dataApiKey = secrets.VALIQ_DATA_API

            if (!dataApiUrl || !dataApiKey) {
                return []
            }

            const client = new ValiqDataClient({
                apiUrl: dataApiUrl,
                apiKey: dataApiKey,
            })
            const data = new ValiqDataAdapter(client)
            return [createValiqBreakingNewsTool(data)]
        }

        const tools = getExtraTools({
            VALIQ_DATA_API_URL: "https://data.example.com",
            VALIQ_DATA_API: "key-123",
        })

        expect(tools).toHaveLength(1)
        expect(tools[0]!.name).toBe("get_breaking_news")
    })
})
