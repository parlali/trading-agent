import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@valiq-trading/agent"
import type { RunOrderRow } from "@valiq-trading/convex"

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

    it("builds decisionRecord from assistant transcript messages plus run summary with last artifacts winning", async () => {
        const { buildRunDecisionRecord } = await import("./scheduler-run-support")
        const earlierAssistant = [
            "FORECAST | direction=long | p=0.51 | expected_move=stale | horizon=10m | invalidation=Old invalidation.",
            "DECISION_RECORD",
            "decision: no_trade",
            "detail: stale record",
            "rules_applied:",
            "- \"Old rule\"",
            "END_DECISION_RECORD",
        ].join("\n")
        const laterAssistant = [
            "The final assistant turn held the existing position.",
            "```DECISION_RECORD",
            "decision: manage_only",
            "detail: Held existing GBPUSD short 0.09 @ 1.33247 unchanged.",
            "rules_applied:",
            "- \"Focus on: checking positions, evaluating if your thesis still holds, adjusting or closing positions, and monitoring fills.\"",
            "- NOT IN TEXT: Current quote still supports holding because price is below invalidation and spread is normal.",
            "END_DECISION_RECORD",
            "```",
        ].join("\n")
        const summary = "FORECAST | direction=short | p=0.57 | expected_move=1.3286 target / ~-0.22% from 1.33148 ask | horizon=NY overlap into 20:45 UTC flat buffer | invalidation=Sustained reclaim above 1.3330/1.3340 or SL 1.3343 invalidates downside continuation."

        expect(buildRunDecisionRecord({
            decisionRecord: true,
        }, summary, [{
            sequence: 20,
            role: "assistant",
            content: laterAssistant,
        }, {
            sequence: 10,
            role: "assistant",
            content: earlierAssistant,
        }, {
            sequence: 30,
            role: "tool",
            content: [
                "FORECAST | direction=neutral | p=0.99 | expected_move=ignored | horizon=ignored | invalidation=ignored.",
                "DECISION_RECORD",
                "decision: trade",
                "detail: ignored tool content",
                "rules_applied:",
                "- \"Ignored rule\"",
                "END_DECISION_RECORD",
            ].join("\n"),
        }])).toMatchObject({
            forecast: {
                direction: "short",
                p: 0.57,
                expectedMove: "1.3286 target / ~-0.22% from 1.33148 ask",
                horizon: "NY overlap into 20:45 UTC flat buffer",
                invalidation: "Sustained reclaim above 1.3330/1.3340 or SL 1.3343 invalidates downside continuation.",
            },
            decision: "manage_only",
            detail: "Held existing GBPUSD short 0.09 @ 1.33247 unchanged.",
            rulesApplied: [
                "Focus on: checking positions, evaluating if your thesis still holds, adjusting or closing positions, and monitoring fills.",
            ],
            notInText: [
                "Current quote still supports holding because price is below invalidation and spread is normal.",
            ],
        })
    })

    it("marks model trades with only validation rejections as trade_blocked", async () => {
        const { buildRunDecisionRecord } = await import("./scheduler-run-support")

        expect(buildRunDecisionRecord({
            decisionRecord: true,
        }, decisionRecordSummary("trade"), [], {
            canonicalOrders: [],
            validationRejectedCount: 3,
        })).toMatchObject({
            decision: "trade",
            effectiveDecision: "trade_blocked",
        })
    })

    it("marks accepted entry or close orders as trade", async () => {
        const { buildRunDecisionRecord } = await import("./scheduler-run-support")

        expect(buildRunDecisionRecord({
            decisionRecord: true,
        }, decisionRecordSummary("trade"), [], {
            canonicalOrders: [canonicalOrder("entry", "filled", 1)],
            validationRejectedCount: 3,
        })).toMatchObject({
            decision: "trade",
            effectiveDecision: "trade",
        })
    })

    it("marks pure model declines as no_trade", async () => {
        const { buildRunDecisionRecord } = await import("./scheduler-run-support")

        expect(buildRunDecisionRecord({
            decisionRecord: true,
        }, decisionRecordSummary("no_trade"), [], {
            canonicalOrders: [],
            validationRejectedCount: 0,
        })).toMatchObject({
            decision: "no_trade",
            effectiveDecision: "no_trade",
        })
    })

    it("marks modify-only runs as manage_only", async () => {
        const { buildRunDecisionRecord } = await import("./scheduler-run-support")

        expect(buildRunDecisionRecord({
            decisionRecord: true,
        }, decisionRecordSummary("manage_only"), [], {
            canonicalOrders: [canonicalOrder("modify", "pending", 0)],
            validationRejectedCount: 0,
        })).toMatchObject({
            decision: "manage_only",
            effectiveDecision: "manage_only",
        })
    })
})

function decisionRecordSummary(decision: "trade" | "no_trade" | "manage_only"): string {
    return [
        "DECISION_RECORD",
        `decision: ${decision}`,
        "detail: replay fixture",
        "END_DECISION_RECORD",
    ].join("\n")
}

function canonicalOrder(
    action: RunOrderRow["action"],
    status: RunOrderRow["status"],
    filledQuantity: number
): Pick<RunOrderRow, "action" | "status" | "filledQuantity"> {
    return {
        action,
        status,
        filledQuantity,
    }
}

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
