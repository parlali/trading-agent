import {
    ALLOWED_VALIDATION_RESULT,
    openIntentRiskValidator,
    okxPolicySchema,
    rejectRisk,
    validateTradingHoursWindow,
    type OrderIntent,
    type RiskValidator,
} from "@valiq-trading/core"

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

function readOkxEntryLevels(intent: OrderIntent): {
    entryPrice?: number
    stopLoss?: number
    takeProfit?: number
} {
    return {
        entryPrice: readFiniteNumber(intent.limitPrice ?? intent.metadata?.estimatedPrice),
        stopLoss: readFiniteNumber(intent.metadata?.stopLoss),
        takeProfit: readFiniteNumber(intent.metadata?.takeProfit),
    }
}

const allowedInstrumentsValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const allowed = new Set(policy.allowedInstruments.map((instrument: string) => instrument.toUpperCase()))
    const instrument = intent.instrument.toUpperCase()

    if (!allowed.has(instrument)) {
        return rejectRisk(`Instrument ${instrument} is not in allowedInstruments: ${policy.allowedInstruments.join(", ")}`)
    }

    return ALLOWED_VALIDATION_RESULT
})

const slTpRequiredValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const stopLoss = intent.metadata?.stopLoss as number | undefined
    const takeProfit = intent.metadata?.takeProfit as number | undefined

    if (stopLoss === undefined || stopLoss === null) {
        return rejectRisk("OKX swap entries require stopLoss")
    }

    if (policy.requireTakeProfit && (takeProfit === undefined || takeProfit === null)) {
        return rejectRisk("OKX policy requires takeProfit for new entries")
    }

    return ALLOWED_VALIDATION_RESULT
})

const minRiskRewardValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)

    if (policy.minRiskReward === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const { entryPrice, stopLoss, takeProfit } = readOkxEntryLevels(intent)

    if (entryPrice === undefined || stopLoss === undefined || takeProfit === undefined) {
        return rejectRisk("OKX minRiskReward gate requires finite entry, stopLoss, and takeProfit")
    }

    const riskDistance = Math.abs(entryPrice - stopLoss)

    if (riskDistance === 0) {
        return rejectRisk("OKX minRiskReward gate requires stopLoss to differ from entry")
    }

    const riskReward = Math.abs(takeProfit - entryPrice) / riskDistance

    if (riskReward < policy.minRiskReward) {
        return rejectRisk(`Risk-reward ratio ${riskReward.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your take-profit or use a wider structural stop.`)
    }

    return ALLOWED_VALIDATION_RESULT
})

const minStopDistanceValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)

    if (policy.minStopDistancePercent === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const { entryPrice, stopLoss } = readOkxEntryLevels(intent)

    if (entryPrice === undefined || stopLoss === undefined) {
        return rejectRisk("OKX minStopDistancePercent gate requires finite entry and stopLoss")
    }

    if (entryPrice <= 0) {
        return rejectRisk("OKX minStopDistancePercent gate requires a positive entry price")
    }

    const distancePercent = 100 * Math.abs(entryPrice - stopLoss) / entryPrice

    if (distancePercent < policy.minStopDistancePercent) {
        return rejectRisk(`Stop distance ${distancePercent.toFixed(2)}% of entry is below the minimum ${policy.minStopDistancePercent}%. Stops inside execution-cost noise get harvested; place the stop beyond real structure or skip the trade.`)
    }

    return ALLOWED_VALIDATION_RESULT
})

const explicitTimeInForceValidator: RiskValidator = openIntentRiskValidator((intent) => {
    if (intent.timeInForce === "day") {
        return rejectRisk("OKX swap does not infer end-of-day expiration from timeInForce=day. Use gtc, ioc, or fok with explicit cancellation policy.")
    }

    return ALLOWED_VALIDATION_RESULT
})

const maxLeverageValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const leverage = intent.metadata?.leverage as number | undefined
    if (leverage === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    if (leverage > policy.maxLeverage) {
        return rejectRisk(`Leverage ${leverage}x exceeds configured maxLeverage ${policy.maxLeverage}x`)
    }

    return ALLOWED_VALIDATION_RESULT
})

const maxRiskPercentValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const riskPercent = intent.metadata?.riskPercent as number | undefined
    if (riskPercent === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    if (riskPercent > policy.maxRiskPercent) {
        return rejectRisk(`Risk ${riskPercent.toFixed(2)}% exceeds maxRiskPercent ${policy.maxRiskPercent}%`)
    }

    return ALLOWED_VALIDATION_RESULT
})

const tradingHoursValidator: RiskValidator = openIntentRiskValidator((_intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours

    return validateTradingHoursWindow({ start, end, timezone })
})

const fundingRateValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const fundingRate = intent.metadata?.fundingRate as number | undefined

    if (fundingRate === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const hostileCarry = intent.side === "buy"
        ? fundingRate > policy.fundingRateThreshold
        : fundingRate < -policy.fundingRateThreshold

    if (hostileCarry) {
        return rejectRisk(`Funding rate ${fundingRate.toFixed(6)} is hostile to ${intent.side} exposure beyond threshold ${policy.fundingRateThreshold.toFixed(6)}`)
    }

    return ALLOWED_VALIDATION_RESULT
})

export const okxRiskValidators: readonly RiskValidator[] = [
    allowedInstrumentsValidator,
    explicitTimeInForceValidator,
    slTpRequiredValidator,
    maxLeverageValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
    fundingRateValidator,
    minStopDistanceValidator,
    minRiskRewardValidator,
]
