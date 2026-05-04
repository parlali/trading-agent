import type { OrderIntent, OrderLifecycleContext, Position } from "./types"
import { readFiniteNumber } from "./value-readers"

export function withLifecycleAction(intent: OrderIntent, lifecycleContext: OrderLifecycleContext): OrderIntent {
    if (!lifecycleContext.action || intent.metadata?.action) {
        return intent
    }

    return {
        ...intent,
        metadata: {
            ...intent.metadata,
            action: lifecycleContext.action,
            ...lifecycleContext.metadata,
        },
    }
}

export function orderSideForPositionSide(side: Position["side"]): "buy" | "sell" {
    return side === "long" ? "buy" : "sell"
}

export function readPositionSide(value: unknown): Position["side"] | undefined {
    return value === "long" || value === "short"
        ? value
        : undefined
}

export function readNumber(value: unknown): number | undefined {
    return readFiniteNumber(value)
}
