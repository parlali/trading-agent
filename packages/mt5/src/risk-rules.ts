import {
    getRiskBudgetBase,
    getCurrentTimeInTimezone,
    mt5PolicySchema,
    padTime,
    type OrderIntent,
    type RiskValidator,
} from "@valiq-trading/core"

const ALLOWED = { allowed: true } as const

const slTpRequiredValidator: RiskValidator = openIntentValidator((intent) => {
    const sl = intent.metadata?.stopLoss as number | undefined
    const tp = intent.metadata?.takeProfit as number | undefined

    if (sl === undefined || sl === null) {
        return rejectRisk("MT5 orders require a stopLoss. Provide stopLoss with your order.")
    }

    if (tp === undefined || tp === null) {
        return rejectRisk("MT5 orders require a takeProfit. Provide takeProfit (or riskRewardRatio) with your order.")
    }

    return ALLOWED
})

const minRiskRewardValidator: RiskValidator = openIntentValidator((intent, rawPolicy) => {
    const policy = mt5PolicySchema.parse(rawPolicy)
    const impliedRR = intent.metadata?.impliedRR as number | undefined

    if (impliedRR === undefined) {
        return ALLOWED
    }

    if (impliedRR < policy.minRiskReward) {
        return rejectRisk(`Risk-reward ratio ${impliedRR.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your TP or tighten your SL.`)
    }

    return ALLOWED
})

const maxRiskPercentValidator: RiskValidator = openIntentValidator((intent, rawPolicy, state) => {
    const policy = mt5PolicySchema.parse(rawPolicy)

    if (getRiskBudgetBase(state) <= 0) {
        return ALLOWED
    }

    const riskPercent = intent.metadata?.riskPercent as number | undefined
    if (riskPercent === undefined) {
        return ALLOWED
    }

    if (riskPercent > policy.maxRiskPercent) {
        return rejectRisk(`Risk ${riskPercent.toFixed(1)}% exceeds max ${policy.maxRiskPercent}%`)
    }

    return ALLOWED
})

const tradingHoursValidator: RiskValidator = openIntentValidator((_intent, rawPolicy) => {
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
        return rejectRisk(`Outside trading hours. Current time: ${padTime(now.hours)}:${padTime(now.minutes)} ${timezone}. Allowed: ${start}-${end}`)
    }

    return ALLOWED
})

export const mt5RiskValidators: readonly RiskValidator[] = [
    slTpRequiredValidator,
    minRiskRewardValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
]

function isCloseAction(intent: OrderIntent): boolean {
    const action = intent.metadata?.action
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order"
}

function openIntentValidator(validate: RiskValidator): RiskValidator {
    return (intent, policy, state, positions) => {
        if (isCloseAction(intent)) {
            return ALLOWED
        }

        return validate(intent, policy, state, positions)
    }
}

function rejectRisk(reason: string): { allowed: false; reason: string } {
    return { allowed: false, reason }
}
