import { describe, expect, it } from "vitest"
import { createMcpConnectionProviderScope } from "../../convex/lib/mcpConnectionScope"

describe("MCP connection provider scope", () => {
    it("builds runtime provider approvals from persisted strategy whitelist state", () => {
        const scope = createMcpConnectionProviderScope([
            {
                id: "macro",
                url: "https://mcp.example/rpc",
                discoveryTools: [{
                    name: "tool_search",
                    inputs: [{ query: "", limit: 50 }],
                }],
            },
        ], {
            discoveryTools: [{
                providerId: "macro",
                toolName: "discover_tools",
                input: { category: "macro_analysis" },
            }],
            tools: [
                {
                    providerId: "macro",
                    toolName: "rates",
                    registeredName: "mcp_macro_rates",
                    schemaHash: "a".repeat(64),
                },
                {
                    providerId: "missing",
                    toolName: "calendar",
                    registeredName: "mcp_missing_calendar",
                    schemaHash: "b".repeat(64),
                },
            ],
        })

        expect(scope.providers).toEqual([{
            id: "macro",
            url: "https://mcp.example/rpc",
            allowedTools: ["rates"],
            approvedTools: [{
                name: "rates",
                registeredName: "mcp_macro_rates",
                schemaHash: "a".repeat(64),
            }],
            discoveryTools: [
                {
                    name: "tool_search",
                    inputs: [{ query: "", limit: 50 }],
                },
                {
                    name: "discover_tools",
                    inputs: [{ category: "macro_analysis" }],
                },
            ],
        }])
        expect(scope.missingProviderIds).toEqual(["missing"])
    })
})
