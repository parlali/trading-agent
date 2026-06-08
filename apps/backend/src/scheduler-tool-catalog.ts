import type { ToolCategory } from "@valiq-trading/agent"

export const SCHEDULER_EXTRA_TOOL_CATEGORIES = {
    query_valiq_research: "research",
    query_valiq_data: "research",
    get_breaking_news: "research",
    search_markets: "research",
} as const satisfies Record<string, ToolCategory>

export function listSchedulerExtraToolNames(): string[] {
    return Object.keys(SCHEDULER_EXTRA_TOOL_CATEGORIES).sort((left, right) => left.localeCompare(right))
}
