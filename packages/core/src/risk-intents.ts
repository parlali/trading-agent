import type { OrderAction } from "./orders"
import { getIntentAction } from "./intent"
import type { OrderIntent } from "./types"

export function getIntentLifecycleAction(intent: OrderIntent): OrderAction | undefined {
    const action = intent.metadata?.action
    if (
        action === "entry" ||
        action === "adjustment" ||
        action === "close" ||
        action === "modify" ||
        action === "cancel"
    ) {
        return action
    }
    return undefined
}

export function isRiskReducingAction(action: OrderAction | undefined): boolean {
    return action === "close" || action === "cancel"
}

export function isRiskReducingIntent(intent: OrderIntent): boolean {
    const action = getIntentLifecycleAction(intent)
    if (isRiskReducingAction(action)) {
        return true
    }

    if (action === "modify" || action === "adjustment") {
        return intent.metadata?.riskReducing === true
    }

    return false
}

export function isCloseOrCancelIntent(intent: OrderIntent): boolean {
    return isRiskReducingAction(getIntentAction(intent))
}
