import { describe, expect, it } from "vitest"
import {
    buildRunDiagnosticsPatch,
    runDiagnosticsV,
} from "../../convex/lib/mutations/orders"

describe("run diagnostics persistence helpers", () => {
    it("keeps OpenRouter provider diagnostics in the updateRun patch model", () => {
        const patch = buildRunDiagnosticsPatch({
            llmProvider: "openrouter",
            llmModel: "anthropic/test",
            llmBillingMode: "openrouter",
            llmResponseIds: ["response-1"],
            openRouterResponseIds: ["legacy-response-1"],
            promptTokens: 11,
            completionTokens: 7,
            reasoningTokens: 3,
            llmCost: 0.012,
        })

        expect(runDiagnosticsV).toBeDefined()
        expect(patch).toEqual({
            llmProvider: "openrouter",
            llmModel: "anthropic/test",
            llmBillingMode: "openrouter",
            llmResponseIds: ["response-1"],
            openRouterResponseIds: ["legacy-response-1"],
            promptTokens: 11,
            completionTokens: 7,
            reasoningTokens: 3,
            llmCost: 0.012,
        })
    })

    it("keeps Codex provider diagnostics in the updateRun patch model", () => {
        const before = {
            primary: {
                usedPercent: 10,
            },
        }
        const after = {
            primary: {
                usedPercent: 12,
            },
        }
        const patch = buildRunDiagnosticsPatch({
            llmProvider: "codex",
            llmModel: "codex-test",
            llmAuthMode: "chatgpt",
            llmBillingMode: "codex-subscription",
            llmResponseIds: [],
            codexThreadId: "thread-1",
            codexTurnIds: ["turn-1"],
            llmRateLimitSnapshotBefore: before,
            llmRateLimitSnapshotAfter: after,
            promptTokens: 17,
            completionTokens: 9,
            reasoningTokens: 4,
        })

        expect(runDiagnosticsV).toBeDefined()
        expect(patch).toEqual({
            llmProvider: "codex",
            llmModel: "codex-test",
            llmAuthMode: "chatgpt",
            llmBillingMode: "codex-subscription",
            llmResponseIds: [],
            codexThreadId: "thread-1",
            codexTurnIds: ["turn-1"],
            llmRateLimitSnapshotBefore: before,
            llmRateLimitSnapshotAfter: after,
            promptTokens: 17,
            completionTokens: 9,
            reasoningTokens: 4,
        })
    })
})
