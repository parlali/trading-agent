import { z } from "zod"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    webSearchParamsSchema,
} from "../tool-contracts"

export interface SearchResult {
    title: string
    url: string
    snippet: string
}

export interface WebSearchProvider {
    search(query: string, maxResults?: number): Promise<SearchResult[]>
}

export function createWebSearchTool(provider: WebSearchProvider): ToolDefinition {
    return createToolDefinition({
        name: "web_search",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof webSearchParamsSchema>
            const results = await provider.search(validated.query, validated.maxResults)
            return { results }
        },
    })
}
