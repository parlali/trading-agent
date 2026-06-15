import { describe, expect, it, vi } from "vitest"
import { resolveMcpProviderConfigs } from "./provider-config"

describe("MCP provider config", () => {
    it("normalizes single-provider env fallback values", () => {
        expect(resolveMcpProviderConfigs({
            secrets: {
                MCP_SERVER_URL: " https://mcp.example/mcp \n",
                MCP_SERVER_TOKEN: " token \n",
                MCP_SERVER_ALLOWED_TOOLS: " search,lookup ",
            },
        })).toEqual([{
            id: "default",
            url: "https://mcp.example/mcp",
            token: "token",
            category: "research",
            allowedTools: ["search", "lookup"],
            compatibleVenues: undefined,
        }])
    })

    it("warns when a normalized token is configured without a URL", () => {
        const logger = {
            warn: vi.fn(),
        }

        expect(resolveMcpProviderConfigs({
            secrets: {
                MCP_SERVER_TOKEN: " token \n",
            },
            logger,
        })).toEqual([])
        expect(logger.warn).toHaveBeenCalledWith("MCP server token ignored because MCP_SERVER_URL is not configured")
    })

    it("normalizes JSON provider allowlists and blocklists", () => {
        expect(resolveMcpProviderConfigs({
            secrets: {
                MCP_PROVIDER_CONFIGS: JSON.stringify([{
                    id: "macro",
                    url: "https://mcp.example/mcp",
                    allowedTools: ["search"],
                    blockedTools: ["write"],
                }]),
            },
        })[0]).toMatchObject({
            id: "macro",
            allowedTools: ["search"],
            blockedTools: ["write"],
        })
    })
})
