import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
    Object.assign(globalThis, {
        Bun: {
            env: {
                CONVEX_URL: "https://convex.test",
                BACKEND_SERVICE_TOKEN: "backend-token",
            },
        },
    })
})

import type { ExecutionPipeline, Logger, VenueAdapter } from "@valiq-trading/core"
import { createLogger } from "@valiq-trading/core"
import { buildToolPool } from "./scheduler-tool-pool"

function baseConfig(llmProvider: "openrouter" | "codex") {
    return {
        app: "polymarket" as const,
        strategyId: "strategy-1",
        venue: {} as VenueAdapter,
        pipeline: {} as ExecutionPipeline,
        policy: {},
        extraTools: [],
        isCallback: false,
        runLogger: createLogger() as Logger,
        llmProvider,
    }
}

describe("buildToolPool web tool gating", () => {
    it("registers web_search and web_fetch only for the openrouter provider", () => {
        const openrouterNames = buildToolPool(baseConfig("openrouter"))
            .forVenue("polymarket")
            .map((tool) => tool.name)
        const codexNames = buildToolPool(baseConfig("codex"))
            .forVenue("polymarket")
            .map((tool) => tool.name)

        expect(openrouterNames).toContain("web_search")
        expect(openrouterNames).toContain("web_fetch")
        expect(codexNames).not.toContain("web_search")
        expect(codexNames).not.toContain("web_fetch")
    })
})
