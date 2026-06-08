import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { executeAgentRun } from "./runtime"
import { ToolRegistry } from "./tool-registry"
import type { LLMResponse } from "./llm-client"
import { createLogger } from "@valiq-trading/core"
import { createPolymarketGetMarketPriceTool } from "./tools/get-market-price-polymarket"
import { OpenRouterChatClient } from "./providers/openrouter/openrouter-chat-client"

const baseUsage = {
    promptTokens: 10,
    completionTokens: 5,
    reasoningTokens: 0,
    cost: 0,
    responseIds: [],
}

beforeEach(() => {
    vi.restoreAllMocks()
})

describe("executeAgentRun degraded research", () => {
    it("rejects observed truncated Polymarket token IDs before provider access", async () => {
        const invalidTokenIds = ["425888", "575692", "453795", "463591", "515959"]
        const chat = vi.fn(async (): Promise<LLMResponse> => {
            const callIndex = chat.mock.calls.length
            if (callIndex === 1) {
                return {
                    content: null,
                    toolCalls: invalidTokenIds.map((tokenId, index) => ({
                        id: `call-invalid-${index}`,
                        type: "function",
                        function: {
                            name: "get_market_price",
                            arguments: JSON.stringify({ tokenId }),
                        },
                    })),
                    usage: baseUsage,
                    finishReason: "tool_calls",
                }
            }

            return {
                content: "Invalid Polymarket identifiers rejected before CLOB access",
                toolCalls: [],
                usage: baseUsage,
                finishReason: "stop",
            }
        })

        vi.spyOn(OpenRouterChatClient.prototype, "chat").mockImplementation(chat)

        const venue = {
            getMarketPrice: vi.fn(),
        }
        const tools = new ToolRegistry()
        tools.register(createPolymarketGetMarketPriceTool(venue as never))

        const result = await executeAgentRun(
            {
                runId: "run-invalid-polymarket",
                strategyId: "strategy-1",
                app: "polymarket",
                timestamp: Date.now(),
                trigger: "cron",
                positions: [],
                accountState: {
                    balance: 10_000,
                    equity: 10_000,
                    buyingPower: 10_000,
                    marginUsed: 0,
                    marginAvailable: 10_000,
                    openPnl: 0,
                    dayPnl: 0,
                },
                policy: {
                    dryRun: true,
                    llm: {
                        provider: "openrouter",
                        model: "gpt-5.4",
                    },
                },
                context: "Replay invalid truncated token IDs",
            },
            {
                provider: {
                    provider: "openrouter",
                    apiKey: "test",
                    model: "test-model",
                },
                tools,
                logger: createLogger({ minLevel: "fatal" }),
                maxIterations: 3,
            }
        )

        expect(result.error).toContain("Circuit breaker")
        expect(result.error).toContain("Polymarket tokenId must be the canonical")
        expect(result.summary).toBe("")
        expect(venue.getMarketPrice).not.toHaveBeenCalled()
    })

    it("treats repeated search_markets failures as degraded research instead of a hard run failure", async () => {
        const chat = vi.fn(async (): Promise<LLMResponse> => {
            const callIndex = chat.mock.calls.length
            if (callIndex <= 3) {
                return {
                    content: null,
                    toolCalls: [{
                        id: `call-search-${callIndex}`,
                        type: "function",
                        function: {
                            name: "search_markets",
                            arguments: JSON.stringify({ category: "politics" }),
                        },
                    }],
                    usage: baseUsage,
                    finishReason: "tool_calls",
                }
            }

            return {
                content: "Stayed flat after discovery degraded",
                toolCalls: [],
                usage: baseUsage,
                finishReason: "stop",
            }
        })

        vi.spyOn(OpenRouterChatClient.prototype, "chat").mockImplementation(chat)

        const tools = new ToolRegistry()
        tools.register({
            name: "search_markets",
            description: "Discovery tool",
            parameters: z.object({
                category: z.string(),
            }),
            jsonSchema: {
                type: "object",
                properties: {
                    category: {
                        type: "string",
                    },
                },
                required: ["category"],
            },
            handler: async () => {
                throw new Error("404 Not Found")
            },
        })

        const result = await executeAgentRun(
            {
                runId: "run-2",
                strategyId: "strategy-1",
                app: "polymarket",
                timestamp: Date.now(),
                trigger: "cron",
                positions: [],
                accountState: {
                    balance: 10_000,
                    equity: 10_000,
                    buyingPower: 10_000,
                    marginUsed: 0,
                    marginAvailable: 10_000,
                    openPnl: 0,
                    dayPnl: 0,
                },
                policy: {
                    dryRun: true,
                    llm: {
                        provider: "openrouter",
                        model: "gpt-5.4",
                    },
                },
                context: "Discover then act",
            },
            {
                provider: {
                    provider: "openrouter",
                    apiKey: "test",
                    model: "test-model",
                },
                tools,
                logger: createLogger({ minLevel: "fatal" }),
                maxIterations: 8,
            }
        )

        expect(result.error).toBeUndefined()
        expect(result.summary).toContain("Stayed flat")
        expect(result.degradedResearch?.active).toBe(true)
        expect(result.degradedResearch?.reasons.some((reason) => reason.includes("search_markets"))).toBe(true)
    })
})
