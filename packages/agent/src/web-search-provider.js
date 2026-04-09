import { fetchWithTimeout } from "@valiq-trading/core";
const SEARCH_REQUEST_TIMEOUT_MS = 15_000;
export class DuckDuckGoSearchProvider {
    async search(query, maxResults = 5) {
        const response = await fetchWithTimeout(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
                "User-Agent": "ValiqTradingAgent/1.0",
            },
        }, SEARCH_REQUEST_TIMEOUT_MS, "DuckDuckGo search request");
        if (!response.ok) {
            throw new Error(`Search request failed: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const results = [];
        const matches = html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g);
        for (const match of matches) {
            const url = decodeDuckDuckGoUrl(match[1] ?? "");
            const title = stripHtml(match[2] ?? "");
            if (!url || !title) {
                continue;
            }
            results.push({
                title,
                url,
                snippet: "",
            });
            if (results.length >= maxResults) {
                break;
            }
        }
        return results;
    }
}
function decodeDuckDuckGoUrl(url) {
    try {
        const parsed = new URL(url, "https://duckduckgo.com");
        return parsed.searchParams.get("uddg") ?? parsed.toString();
    }
    catch {
        return url;
    }
}
function stripHtml(value) {
    return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
