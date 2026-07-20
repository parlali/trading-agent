import {
    ALLOWED_VALIDATION_RESULT,
    allowWithGateEvaluation,
    createGateEvaluation,
    getIntentAction,
    openIntentRiskValidator,
    okxPolicySchema,
    readFiniteNumber,
    readNonNegativeFiniteNumber,
    rejectRisk,
    rejectRiskWithGateEvaluation,
    resolveStopDistanceSpreadMultiple,
    validateTradingHoursWindow,
    type OrderIntent,
    type RiskValidator,
} from "@valiq-trading/core"

function readOkxEntryLevels(intent: OrderIntent): {
    entryPrice?: number
    stopLoss?: number
    takeProfit?: number
    absoluteSpread?: number
} {
    return {
        entryPrice: readFiniteNumber(intent.limitPrice ?? intent.metadata?.estimatedPrice),
        stopLoss: readFiniteNumber(intent.metadata?.stopLoss),
        takeProfit: readFiniteNumber(intent.metadata?.takeProfit),
        absoluteSpread: readNonNegativeFiniteNumber(intent.metadata?.absoluteSpread),
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
    const gateEvaluation = createGateEvaluation({
        gateKey: "okx.minRiskReward",
        observed: riskReward,
        threshold: policy.minRiskReward,
        comparison: "min",
    })

    if (riskReward < policy.minRiskReward) {
        return rejectRiskWithGateEvaluation(
            `Risk-reward ratio ${riskReward.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your take-profit or use a wider structural stop.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
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
    const gateEvaluation = createGateEvaluation({
        gateKey: "okx.minStopDistancePercent",
        observed: distancePercent,
        threshold: policy.minStopDistancePercent,
        comparison: "min",
    })

    if (distancePercent < policy.minStopDistancePercent) {
        return rejectRiskWithGateEvaluation(
            `Stop distance ${distancePercent.toFixed(2)}% of entry is below the minimum ${policy.minStopDistancePercent}%. Stops inside execution-cost noise get harvested; place the stop beyond real structure or skip the trade.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

const minStopDistanceSpreadMultipleValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)

    if (policy.minStopDistanceSpreadMultiple === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    if (getIntentAction(intent) !== "entry") {
        return ALLOWED_VALIDATION_RESULT
    }

    const { entryPrice, stopLoss, absoluteSpread } = readOkxEntryLevels(intent)
    const failClosedGateEvaluation = createGateEvaluation({
        gateKey: "okx.minStopDistanceSpreadMultiple",
        observed: 0,
        threshold: policy.minStopDistanceSpreadMultiple,
        comparison: "min",
    })

    if (entryPrice === undefined || stopLoss === undefined) {
        return rejectRiskWithGateEvaluation(
            "OKX minStopDistanceSpreadMultiple gate requires finite entry and stopLoss",
            failClosedGateEvaluation
        )
    }

    if (absoluteSpread === undefined) {
        return rejectRiskWithGateEvaluation(
            "OKX minStopDistanceSpreadMultiple gate cannot verify stop clearance because intent metadata is missing absoluteSpread",
            failClosedGateEvaluation
        )
    }

    const stopDistance = Math.abs(entryPrice - stopLoss)
    const spreadMultiple = resolveStopDistanceSpreadMultiple(stopDistance, absoluteSpread)
    const minimumStopDistance = policy.minStopDistanceSpreadMultiple * absoluteSpread
    const gateEvaluation = createGateEvaluation({
        gateKey: "okx.minStopDistanceSpreadMultiple",
        observed: spreadMultiple,
        threshold: policy.minStopDistanceSpreadMultiple,
        comparison: "min",
    })

    if (stopDistance < minimumStopDistance) {
        return rejectRiskWithGateEvaluation(
            `Stop distance ${stopDistance.toFixed(5)} is ${spreadMultiple.toFixed(2)}x current spread ${absoluteSpread.toFixed(5)}, below minimum ${policy.minStopDistanceSpreadMultiple}x. Stops inside execution-cost noise get harvested; place the stop beyond real structure or skip the trade.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
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

    const gateEvaluation = createGateEvaluation({
        gateKey: "okx.maxLeverage",
        observed: leverage,
        threshold: policy.maxLeverage,
        comparison: "max",
    })

    if (leverage > policy.maxLeverage) {
        return rejectRiskWithGateEvaluation(
            `Leverage ${leverage}x exceeds configured maxLeverage ${policy.maxLeverage}x`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

const maxRiskPercentValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const riskPercent = intent.metadata?.riskPercent as number | undefined
    if (riskPercent === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "okx.maxRiskPercent",
        observed: riskPercent,
        threshold: policy.maxRiskPercent,
        comparison: "max",
    })

    if (riskPercent > policy.maxRiskPercent) {
        return rejectRiskWithGateEvaluation(
            `Risk ${riskPercent.toFixed(2)}% exceeds maxRiskPercent ${policy.maxRiskPercent}%`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

const tradingHoursValidator: RiskValidator = openIntentRiskValidator((_intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours

    return validateTradingHoursWindow({ start, end, timezone, gateKey: "okx.tradingHours" })
})

const fundingRateValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = okxPolicySchema.parse(rawPolicy)
    const fundingRate = intent.metadata?.fundingRate as number | undefined

    if (fundingRate === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const gateEvaluation = intent.side === "buy"
        ? createGateEvaluation({
            gateKey: "okx.fundingRateThreshold.buy",
            observed: fundingRate,
            threshold: policy.fundingRateThreshold,
            comparison: "max",
        })
        : createGateEvaluation({
            gateKey: "okx.fundingRateThreshold.sell",
            observed: fundingRate,
            threshold: -policy.fundingRateThreshold,
            comparison: "min",
            scale: policy.fundingRateThreshold,
        })
    const hostileCarry = intent.side === "buy"
        ? fundingRate > policy.fundingRateThreshold
        : fundingRate < -policy.fundingRateThreshold

    if (hostileCarry) {
        return rejectRiskWithGateEvaluation(
            `Funding rate ${fundingRate.toFixed(6)} is hostile to ${intent.side} exposure beyond threshold ${policy.fundingRateThreshold.toFixed(6)}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
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
    minStopDistanceSpreadMultipleValidator,
    minRiskRewardValidator,
]
