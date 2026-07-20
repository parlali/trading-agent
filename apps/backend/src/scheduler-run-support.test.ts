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

    it("leaves decisionRecord out of updateRun diagnostics when the policy flag is absent", async () => {
        const {
            buildRunDecisionRecord,
            buildRunDiagnostics,
        } = await import("./scheduler-run-support")
        const result = createAgentRunResult()
        const diagnostics: Record<string, unknown> = {
            ...(buildRunDiagnostics(result) ?? {}),
        }
        const decisionRecord = buildRunDecisionRecord({
            dryRun: true,
        }, result.summary)
        if (decisionRecord !== undefined) {
            diagnostics.decisionRecord = decisionRecord
        }

        expect(diagnostics).not.toHaveProperty("decisionRecord")
    })

    it("builds a parsed decisionRecord only when the policy flag is true", async () => {
        const { buildRunDecisionRecord } = await import("./scheduler-run-support")
        const summary = [
            "FORECAST | direction=long | p=0.57 | expected_move=+0.5% | horizon=30m | invalidation=Lose the breakout.",
            "```",
            "DECISION_RECORD",
            "decision: manage_only",
            "detail: monitor the existing position",
            "rules_applied:",
            "- \"For limit orders, monitor fill status and adjust or cancel if not filling.\"",
            "END_DECISION_RECORD",
            "```",
        ].join("\n")

        expect(buildRunDecisionRecord({
            decisionRecord: false,
        }, summary)).toBeUndefined()
        expect(buildRunDecisionRecord({
            decisionRecord: true,
        }, summary)).toMatchObject({
            decision: "manage_only",
            detail: "monitor the existing position",
            rulesApplied: [
                "For limit orders, monitor fill status and adjust or cancel if not filling.",
            ],
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
