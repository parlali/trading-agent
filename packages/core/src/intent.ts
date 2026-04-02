import type { OrderIntent } from "./types"
import type { OrderAction } from "./orders"

export const getIntentAction = (intent: OrderIntent, fallback: OrderAction = "entry"): OrderAction => {
    const action = intent.metadata?.action

    if (action === "entry" || action === "adjustment" || action === "close" || action === "modify" || action === "cancel") {
        return action
    }

    if (action === "close_position") {
        return "close"
    }

    if (action === "modify_order") {
        return "modify"
    }

    if (action === "cancel_order") {
        return "cancel"
    }

    return fallback
}

export const hasIntentChanges = (changes: Partial<OrderIntent>): boolean => {
    return Object.values(changes).some((value) => value !== undefined)
}

export const createSyntheticIntent = (
    action: OrderAction,
    instrument: string,
    side: "buy" | "sell",
    quantity: number,
    orderId?: string,
    metadata?: Record<string, unknown>
): OrderIntent => {
    return {
        instrument,
        side,
        quantity,
        orderType: "market",
        timeInForce: "day",
        metadata: {
            action,
            orderId,
            ...metadata,
        },
    }
}
