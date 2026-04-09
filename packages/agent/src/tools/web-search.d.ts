import type { ToolDefinition } from "../tool-registry";
export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}
export interface WebSearchProvider {
    search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
export declare function createWebSearchTool(provider: WebSearchProvider): ToolDefinition;
//# sourceMappingURL=web-search.d.ts.map