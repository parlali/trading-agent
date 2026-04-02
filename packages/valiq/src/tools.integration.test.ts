import { describe, it, expect, beforeAll } from "vitest"
import { ValiqDataClient } from "./client"
import { ValiqDataAdapter } from "./data"
import { createValiqBreakingNewsTool } from "./tools"

const apiUrl = process.env.VALIQ_DATA_API_URL
const apiKey = process.env.VALIQ_DATA_API_KEY

const canRun = Boolean(apiUrl && apiKey)

describe.skipIf(!canRun)("valiq breaking news -- live integration", () => {
    let client: ValiqDataClient
    let adapter: ValiqDataAdapter

    beforeAll(() => {
        client = new ValiqDataClient({
            apiUrl: apiUrl!,
            apiKey: apiKey!,
        })
        adapter = new ValiqDataAdapter(client)
    })

    it("ValiqDataClient connects and authenticates", async () => {
        const result = await client.request<unknown>("/breaking-news")
        expect(result).toBeDefined()
        expect(result).toHaveProperty("articles")
        expect(result).toHaveProperty("summary")
    })

    it("ValiqDataAdapter.getBreakingNews returns articles", async () => {
        const result = await adapter.getBreakingNews()

        expect(result.articles).toBeDefined()
        expect(Array.isArray(result.articles)).toBe(true)
        expect(result.summary).toBeDefined()
        expect(result.summary).toHaveProperty("window")
        expect(result.summary).toHaveProperty("total_count")
        expect(typeof result.summary.total_count).toBe("number")
    })

    it("getBreakingNews with window param works", async () => {
        const result = await adapter.getBreakingNews({ window: "24h" })

        expect(result.articles).toBeDefined()
        expect(result.summary.window).toBe("24h")
    })

    it("getBreakingNews with source filter works", async () => {
        const result = await adapter.getBreakingNews({ source: "fmp-general" })

        expect(result.articles).toBeDefined()
    })

    it("tool handler returns valid response (full end-to-end)", async () => {
        const tool = createValiqBreakingNewsTool(adapter)

        const result = await tool.handler({})

        expect(result).toHaveProperty("articles")
        expect(result).toHaveProperty("summary")

        const typed = result as { articles: unknown[]; summary: { total_count: number } }
        expect(Array.isArray(typed.articles)).toBe(true)
        expect(typeof typed.summary.total_count).toBe("number")
    })

    it("tool handler with params returns valid response", async () => {
        const tool = createValiqBreakingNewsTool(adapter)

        const result = await tool.handler({ window: "1h" })

        expect(result).toHaveProperty("articles")
        expect(result).toHaveProperty("summary")
    })
})

describe.skipIf(canRun)("valiq integration -- skip notice", () => {
    it("skipped: set VALIQ_DATA_API_URL and VALIQ_DATA_API_KEY to run", () => {
        console.log(
            "Integration tests skipped. Run with:\n" +
            "  VALIQ_DATA_API_URL=... VALIQ_DATA_API_KEY=... bun run test"
        )
    })
})
