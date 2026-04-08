import {
    getRiskBudgetBase,
    getCurrentTimeInTimezone,
    mt5PolicySchema,
    padTime,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export const mt5RiskValidators: readonly RiskValidator[] = [
    slTpRequiredValidator,
    minRiskRewardValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
    emergencyFlattenValidator,
]

function slTpRequiredValidator(
    intent: OrderIntent,
    _rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const sl = intent.metadata?.stopLoss as number | undefined
    const tp = intent.metadata?.takeProfit as number | undefined

    if (sl === undefined || sl === null) {
        return {
            allowed: false,
            reason: "MT5 orders require a stopLoss. Provide stopLoss with your order.",
        }
    }

    if (tp === undefined || tp === null) {
        return {
            allowed: false,
            reason: "MT5 orders require a takeProfit. Provide takeProfit (or riskRewardRatio) with your order.",
        }
    }

    return { allowed: true }
}

function minRiskRewardValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)
    const impliedRR = intent.metadata?.impliedRR as number | undefined

    if (impliedRR === undefined) {
        return { allowed: true }
    }

    if (impliedRR < policy.minRiskReward) {
        return {
            allowed: false,
            reason: `Risk-reward ratio ${impliedRR.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your TP or tighten your SL.`,
        }
    }

    return { allowed: true }
}

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

    if (getRiskBudgetBase(state) <= 0) {
        return { allowed: true }
    }

    const riskPercent = intent.metadata?.riskPercent as number | undefined
    if (riskPercent === undefined) {
        return { allowed: true }
    }

    if (riskPercent > policy.maxRiskPercent) {
        return {
            allowed: false,
            reason: `Risk ${riskPercent.toFixed(1)}% exceeds max ${policy.maxRiskPercent}%`,
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
