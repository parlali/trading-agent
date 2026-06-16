import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@valiq-trading/agent"

const testEnv = {
    CONVEX_URL: "https://convex.test",
    BACKEND_SERVICE_TOKEN: "backend-token",
}
const testRuntime = globalThis as typeof globalThis & {
    Bun?: {
        env: Record<string, string | undefined>
    }
}

if (testRuntime.Bun) {
    Object.assign(testRuntime.Bun.env, testEnv)
} else {
    Object.defineProperty(testRuntime, "Bun", {
        value: {
            env: { ...testEnv },
        },
        configurable: true,
    })
}

describe("scheduler run diagnostics", () => {
    it("includes the shared tool call count", async () => {
        const { buildRunDiagnostics } = await import("./scheduler-run-support")
        const diagnostics = buildRunDiagnostics(createAgentRunResult())

        expect(diagnostics).toMatchObject({
            llmProvider: "openrouter",
            llmModel: "openai/test",
            toolCallCount: 4,
        })
    })
})

function createAgentRunResult(): AgentRunResult {
    return {
        summary: "done",
        iterations: 2,
        usage: {
            promptTokens: 10,
            completionTokens: 5,
            reasoningTokens: 1,
            cost: 0.01,
            responseIds: ["response-1"],
        },
        opportunityCoverage: {
            researched: 1,
            qualified: 1,
            rejectedByModel: 0,
            rejectedByRisk: 0,
            submitted: 1,
            filled: 0,
            closed: 0,
            realizedPnl: 0,
        },
        toolCallCount: 4,
        degradedResearch: {
            active: false,
            reasons: [],
            toolFailureCount: 0,
            retryCount: 0,
            decisionUnderDegradedContext: false,
        },
        providerDiagnostics: {
            provider: "openrouter",
            model: "openai/test",
            billingMode: "openrouter",
            responseIds: ["response-1"],
        },
        toolManifest: [],
    }
}
