import {
    getCurrentTimeInTimezone,
    mt5PolicySchema,
    padTime,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export const mt5RiskValidators: readonly RiskValidator[] = [
    maxRiskPercentValidator,
    tradingHoursValidator,
    emergencyFlattenValidator,
]

function maxRiskPercentValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState,
    _positions: Position[]
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)

    if (state.balance <= 0) {
        return { allowed: true }
    }

    let riskAmount: number

    if (intent.stopPrice && intent.limitPrice) {
        riskAmount = Math.abs(intent.limitPrice - intent.stopPrice) * intent.quantity
    } else {
        const price = intent.limitPrice ?? intent.stopPrice ?? 0
        riskAmount = price * intent.quantity
    }

    const riskPercent = (riskAmount / state.balance) * 100

    if (riskPercent > policy.maxRiskPercent) {
        return {
            allowed: false,
            reason: `Risk ${riskPercent.toFixed(1)}% of account ($${riskAmount.toFixed(2)}) exceeds max ${policy.maxRiskPercent}%`,
        }
    }

    return { allowed: true }
}

function tradingHoursValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours

    const now = getCurrentTimeInTimezone(timezone)
    const [startHour, startMinute] = start.split(":").map(Number) as [number, number]
    const [endHour, endMinute] = end.split(":").map(Number) as [number, number]

    const currentMinutes = now.hours * 60 + now.minutes
    const startMinutes = startHour * 60 + startMinute
    const endMinutes = endHour * 60 + endMinute

    let withinWindow: boolean

    if (startMinutes <= endMinutes) {
        withinWindow = currentMinutes >= startMinutes && currentMinutes < endMinutes
    } else {
        withinWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes
    }

    if (!withinWindow) {
        return {
            allowed: false,
            reason: `Outside trading hours. Current time: ${padTime(now.hours)}:${padTime(now.minutes)} ${timezone}. Allowed: ${start}-${end}`,
        }
    }

    return { allowed: true }
}

function emergencyFlattenValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)

    if (state.openPnl < 0 && Math.abs(state.openPnl) >= policy.emergencyFlattenThreshold) {
        return {
            allowed: false,
            reason: `Unrealized loss ${Math.abs(state.openPnl).toFixed(2)} exceeds emergency flatten threshold ${policy.emergencyFlattenThreshold}. Close positions first.`,
        }
    }

    return { allowed: true }
}

function isCloseAction(intent: OrderIntent): boolean {
    const action = intent.metadata?.action
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order"
}
