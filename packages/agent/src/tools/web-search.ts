import { z } from "zod"
import type { ToolDefinition } from "../tool-registry"

export interface SearchResult {
    title: string
    url: string
    snippet: string
}

export interface WebSearchProvider {
    search(query: string, maxResults?: number): Promise<SearchResult[]>
}

const paramsSchema = z.object({
    query: z.string(),
    maxResults: z.number().int().positive().max(20).default(5),
})

export function createWebSearchTool(provider: WebSearchProvider): ToolDefinition {
    return {
        name: "web_search",
        description: "Search the internet for information. Returns a list of results with title, URL, and snippet. Useful for market news, event research, and finding current information.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query" },
                maxResults: { type: "number", description: "Maximum number of results (1-20, default 5)" },
            },
            required: ["query"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const results = await provider.search(validated.query, validated.maxResults)
            return { results }
        },
    }
}
