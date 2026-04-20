import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { executeAgentRun } from "./runtime"
import { ToolRegistry } from "./tool-registry"
import type { LLMResponse } from "./llm-client"
import { createLogger } from "@valiq-trading/core"

const baseUsage = {
    promptTokens: 10,
    completionTokens: 5,
    reasoningTokens: 0,
    cost: 0,
}

beforeEach(() => {
    vi.restoreAllMocks()
})

describe("executeAgentRun degraded research", () => {
    it("keeps the run alive in degraded mode after repeated research tool failures", async () => {
        const chat = vi.fn(async (): Promise<LLMResponse> => {
            const callIndex = chat.mock.calls.length
            if (callIndex <= 3) {
                return {
                    content: null,
                    toolCalls: [{
                        id: `call-${callIndex}`,
                        type: "function",
                        function: {
                            name: "query_valiq_research",
                            arguments: "{}",
                        },
                    }],
                    usage: baseUsage,
                    finishReason: "tool_calls",
                }
            }

            return {
                content: "Final decision with bounded context",
                toolCalls: [],
                usage: baseUsage,
                finishReason: "stop",
            }
        })

        const llm = await import("./llm-client")
        vi.spyOn(llm.LLMClient.prototype, "chat").mockImplementation(chat)

        const tools = new ToolRegistry()
        tools.register({
            name: "query_valiq_research",
            description: "Research tool",
            parameters: z.object({}),
            jsonSchema: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                throw new Error("upstream timeout")
            },
        })

        const result = await executeAgentRun(
            {
                runId: "run-1",
                strategyId: "strategy-1",
                app: "okx-swap",
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
                    model: "gpt-5.4",
                },
                context: "Research then act",
            },
            {
                llm: {
                    apiKey: "test",
                    model: "test-model",
                },
                tools,
                logger: createLogger({ minLevel: "fatal" }),
                maxIterations: 8,
            }
        )

        expect(result.error).toBeUndefined()
        expect(result.summary).toContain("Final decision")
        expect(result.degradedResearch?.active).toBe(true)
        expect(result.degradedResearch?.toolFailureCount).toBeGreaterThan(0)
        expect(result.degradedResearch?.decisionUnderDegradedContext).toBe(true)
    })
})
