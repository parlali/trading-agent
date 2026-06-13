import { describe, expect, it } from "vitest"
import { withLifecycleAction } from "./execution-metadata"
import type { OrderIntent } from "./types"

function buildIntent(metadata?: Record<string, unknown>): OrderIntent {
    return {
        instrument: "BTC-USDT-SWAP",
        side: "buy",
        quantity: 1,
        orderType: "market",
        timeInForce: "gtc",
        metadata,
    }
}

describe("withLifecycleAction", () => {
    it("overwrites model-supplied metadata.action with the deterministic lifecycle action", () => {
        const intent = buildIntent({ action: "cancel", reason: "model supplied" })

        const result = withLifecycleAction(intent, { action: "entry" })

        expect(result.metadata?.action).toBe("entry")
        expect(result.metadata?.reason).toBe("model supplied")
    })

    it("keeps the lifecycle action authoritative over lifecycle context metadata", () => {
        const intent = buildIntent({ action: "close" })

        const result = withLifecycleAction(intent, {
            action: "close",
            metadata: { action: "entry", protectionUpdate: true },
        })

        expect(result.metadata?.action).toBe("close")
        expect(result.metadata?.protectionUpdate).toBe(true)
    })

    it("applies the lifecycle action when the intent has no metadata", () => {
        const intent = buildIntent()

        const result = withLifecycleAction(intent, { action: "adjustment" })

        expect(result.metadata?.action).toBe("adjustment")
    })

    it("preserves deterministic synthetic intent metadata when lifecycle action matches", () => {
        const intent = buildIntent({ action: "cancel", orderId: "order-1" })

        const result = withLifecycleAction(intent, { action: "cancel" })

        expect(result.metadata?.action).toBe("cancel")
        expect(result.metadata?.orderId).toBe("order-1")
    })
})
