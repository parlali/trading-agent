import { createToolDefinition, } from "../tool-contracts";
export function createWebSearchTool(provider) {
    return createToolDefinition({
        name: "web_search",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params;
            const results = await provider.search(validated.query, validated.maxResults);
            return { results };
        },
    });
}
