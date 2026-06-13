import { describe, expect, it, vi } from "vitest"
import type { ExecutionPipeline, OrderIntent, OrderLifecycleContext } from "@valiq-trading/core"
import { createProposeOrderTool } from "./propose-order.ts"
import {
    RESERVED_INTENT_METADATA_KEYS,
    sanitizeModelIntentMetadata,
} from "./model-intent-metadata.ts"

function createPipeline() {
    const executeIntent = vi.fn(async (intent: OrderIntent, _account: unknown, _positions: unknown, lifecycleContext: OrderLifecycleContext) => ({
        result: {
            orderId: "order-1",
            status: "submitted",
            filledQuantity: 0,
            timestamp: Date.now(),
        },
        validation: { allowed: true },
        handle: undefined,
        intent,
        lifecycleContext,
    }))

    const pipeline = {
        executeIntent,
        getPositions: vi.fn(async () => []),
        getAccountState: vi.fn(async () => ({
            balance: 10_000,
            equity: 10_000,
            buyingPower: 10_000,
            marginUsed: 0,
            marginAvailable: 10_000,
            openPnl: 0,
            dayPnl: 0,
        })),
    }

    return { pipeline: pipeline as unknown as ExecutionPipeline, executeIntent }
}

describe("sanitizeModelIntentMetadata", () => {
    it("strips every reserved deterministic key and keeps model-safe keys", () => {
        const metadata: Record<string, unknown> = { thesis: "earnings drift", confidence: 0.7 }
        for (const key of RESERVED_INTENT_METADATA_KEYS) {
            metadata[key] = "injected"
        }

        const sanitized = sanitizeModelIntentMetadata(metadata)

        expect(sanitized).toEqual({ thesis: "earnings drift", confidence: 0.7 })
    })

    it("returns undefined when the model supplies no metadata", () => {
        expect(sanitizeModelIntentMetadata(undefined)).toBeUndefined()
    })
})

describe("createProposeOrderTool", () => {
    it("strips reserved metadata keys and submits with a deterministic entry lifecycle action", async () => {
        const { pipeline, executeIntent } = createPipeline()
        const tool = createProposeOrderTool(pipeline)

        await tool.handler({
            instrument: "IC:SPY:2026-04-24:SPY260424P00650000|SPY260424P00649000|SPY260424C00705000|SPY260424C00706000",
            side: "sell",
            quantity: 5,
            orderType: "limit",
            limitPrice: 0.42,
            timeInForce: "day",
            legs: [
                { instrument: "SPY260424P00650000", side: "sell_to_open", quantity: 1 },
                { instrument: "SPY260424P00649000", side: "buy_to_open", quantity: 1 },
                { instrument: "SPY260424C00705000", side: "sell_to_open", quantity: 1 },
                { instrument: "SPY260424C00706000", side: "buy_to_open", quantity: 1 },
            ],
            metadata: {
                action: "cancel",
                riskReducing: true,
                optionContractMultiplier: 1_000_000,
                contractMultiplier: 1_000_000,
                notionalMultiplier: 1_000_000,
                orderId: "spoofed-order",
                thesis: "model reasoning",
            },
        })

        expect(executeIntent).toHaveBeenCalledTimes(1)
        const [intent, , , lifecycleContext] = executeIntent.mock.calls[0] as [OrderIntent, unknown, unknown, OrderLifecycleContext]

        expect(lifecycleContext).toEqual({ action: "entry" })
        expect(tool.description).toContain("multi-leg credit")
        expect(intent.metadata).toEqual({ thesis: "model reasoning" })
        expect(intent.metadata).not.toHaveProperty("action")
        expect(intent.metadata).not.toHaveProperty("riskReducing")
        expect(intent.metadata).not.toHaveProperty("optionContractMultiplier")
    })
})
