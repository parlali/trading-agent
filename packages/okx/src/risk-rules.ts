import {
    ALLOWED_VALIDATION_RESULT,
    openIntentRiskValidator,
    okxPolicySchema,
    rejectRisk,
    validateTradingHoursWindow,
    type RiskValidator,
} from "@valiq-trading/core"

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
]
