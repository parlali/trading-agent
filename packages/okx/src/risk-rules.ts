import {
    getCurrentTimeInTimezone,
    okxPolicySchema,
    padTime,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export const okxRiskValidators: readonly RiskValidator[] = [
    allowedInstrumentsValidator,
    slTpRequiredValidator,
    maxLeverageValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
    emergencyFlattenValidator,
    fundingRateValidator,
]

function allowedInstrumentsValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = okxPolicySchema.parse(rawPolicy)
    const allowed = new Set(policy.allowedInstruments.map((instrument: string) => instrument.toUpperCase()))
    const instrument = intent.instrument.toUpperCase()

    if (!allowed.has(instrument)) {
        return {
            allowed: false,
            reason: `Instrument ${instrument} is not in allowedInstruments: ${policy.allowedInstruments.join(", ")}`,
        }
    }

    return { allowed: true }
}

function slTpRequiredValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = okxPolicySchema.parse(rawPolicy)
    const stopLoss = intent.metadata?.stopLoss as number | undefined
    const takeProfit = intent.metadata?.takeProfit as number | undefined

    if (stopLoss === undefined || stopLoss === null) {
        return {
            allowed: false,
            reason: "OKX swap entries require stopLoss",
        }
    }

    if (policy.requireTakeProfit && (takeProfit === undefined || takeProfit === null)) {
        return {
            allowed: false,
            reason: "OKX policy requires takeProfit for new entries",
        }
    }

    return { allowed: true }
}

function maxLeverageValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = okxPolicySchema.parse(rawPolicy)
    const leverage = intent.metadata?.leverage as number | undefined
    if (leverage === undefined) {
        return { allowed: true }
    }

    if (leverage > policy.maxLeverage) {
        return {
            allowed: false,
            reason: `Leverage ${leverage}x exceeds configured maxLeverage ${policy.maxLeverage}x`,
        }
    }

    return { allowed: true }
}

function maxRiskPercentValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = okxPolicySchema.parse(rawPolicy)
    const riskPercent = intent.metadata?.riskPercent as number | undefined
    if (riskPercent === undefined) {
        return { allowed: true }
    }

    if (riskPercent > policy.maxRiskPercent) {
        return {
            allowed: false,
            reason: `Risk ${riskPercent.toFixed(2)}% exceeds maxRiskPercent ${policy.maxRiskPercent}%`,
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

    const policy = okxPolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours
    const now = getCurrentTimeInTimezone(timezone)
    const [startHour, startMinute] = start.split(":").map(Number) as [number, number]
    const [endHour, endMinute] = end.split(":").map(Number) as [number, number]

    const currentMinutes = now.hours * 60 + now.minutes
    const startMinutes = startHour * 60 + startMinute
    const endMinutes = endHour * 60 + endMinute

    const withinWindow = startMinutes <= endMinutes
        ? currentMinutes >= startMinutes && currentMinutes < endMinutes
        : currentMinutes >= startMinutes || currentMinutes < endMinutes

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

    const policy = okxPolicySchema.parse(rawPolicy)

    if (state.openPnl < 0 && Math.abs(state.openPnl) >= policy.emergencyFlattenThreshold) {
        return {
            allowed: false,
            reason: `Unrealized loss ${Math.abs(state.openPnl).toFixed(2)} exceeds emergencyFlattenThreshold ${policy.emergencyFlattenThreshold}`,
        }
    }

    return { allowed: true }
}

function fundingRateValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = okxPolicySchema.parse(rawPolicy)
    const fundingRate = intent.metadata?.fundingRate as number | undefined

    if (fundingRate === undefined) {
        return { allowed: true }
    }

    if (Math.abs(fundingRate) > policy.fundingRateThreshold) {
        return {
            allowed: false,
            reason: `Funding rate ${fundingRate.toFixed(6)} exceeds threshold ${policy.fundingRateThreshold.toFixed(6)}`,
        }
    }

    return { allowed: true }
}

function isCloseAction(intent: OrderIntent): boolean {
    const action = intent.metadata?.action
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order"
}
