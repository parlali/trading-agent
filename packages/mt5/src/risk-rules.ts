import {
    ALLOWED_VALIDATION_RESULT,
    allowWithGateEvaluation,
    createGateEvaluation,
    getIntentAction,
    getRiskBudgetBase,
    mt5PolicySchema,
    openIntentRiskValidator,
    rejectRisk,
    rejectRiskWithGateEvaluation,
    readFiniteNumber,
    readNonNegativeFiniteNumber,
    resolveStopDistanceSpreadMultiple,
    resolveTradingHoursWindowState,
    validateTradingHoursWindow,
    type OrderIntent,
    type RiskValidator,
} from "@valiq-trading/core"

function readMT5EntryLevels(intent: OrderIntent): {
    entryPrice?: number
    stopLoss?: number
    absoluteSpread?: number
} {
    return {
        entryPrice: readFiniteNumber(intent.limitPrice ?? intent.metadata?.estimatedPrice),
        stopLoss: readFiniteNumber(intent.metadata?.stopLoss),
        absoluteSpread: readNonNegativeFiniteNumber(intent.metadata?.absoluteSpread),
    }
}

const slTpRequiredValidator: RiskValidator = openIntentRiskValidator((intent) => {
    const sl = intent.metadata?.stopLoss as number | undefined
    const tp = intent.metadata?.takeProfit as number | undefined

    if (sl === undefined || sl === null) {
        return rejectRisk("MT5 orders require a stopLoss. Provide stopLoss with your order.")
    }

    if (tp === undefined || tp === null) {
        return rejectRisk("MT5 orders require a takeProfit. Provide takeProfit (or riskRewardRatio) with your order.")
    }

    return ALLOWED_VALIDATION_RESULT
})

const minRiskRewardValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = mt5PolicySchema.parse(rawPolicy)
    const impliedRR = intent.metadata?.impliedRR as number | undefined

    if (impliedRR === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "mt5.minRiskReward",
        observed: impliedRR,
        threshold: policy.minRiskReward,
        comparison: "min",
    })

    if (impliedRR < policy.minRiskReward) {
        return rejectRiskWithGateEvaluation(
            `Risk-reward ratio ${impliedRR.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your TP or tighten your SL.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

const minStopDistanceSpreadMultipleValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = mt5PolicySchema.parse(rawPolicy)

    if (policy.minStopDistanceSpreadMultiple === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    if (getIntentAction(intent) !== "entry") {
        return ALLOWED_VALIDATION_RESULT
    }

    const { entryPrice, stopLoss, absoluteSpread } = readMT5EntryLevels(intent)
    const failClosedGateEvaluation = createGateEvaluation({
        gateKey: "mt5.minStopDistanceSpreadMultiple",
        observed: 0,
        threshold: policy.minStopDistanceSpreadMultiple,
        comparison: "min",
    })

    if (entryPrice === undefined || stopLoss === undefined) {
        return rejectRiskWithGateEvaluation(
            "MT5 minStopDistanceSpreadMultiple gate cannot verify stop clearance without finite entry and stopLoss",
            failClosedGateEvaluation
        )
    }

    if (absoluteSpread === undefined) {
        return rejectRiskWithGateEvaluation(
            "MT5 minStopDistanceSpreadMultiple gate cannot verify stop clearance because intent metadata is missing absoluteSpread",
            failClosedGateEvaluation
        )
    }

    const stopDistance = Math.abs(entryPrice - stopLoss)
    const spreadMultiple = resolveStopDistanceSpreadMultiple(stopDistance, absoluteSpread)
    const minimumStopDistance = policy.minStopDistanceSpreadMultiple * absoluteSpread
    const gateEvaluation = createGateEvaluation({
        gateKey: "mt5.minStopDistanceSpreadMultiple",
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

const maxRiskPercentValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy, state) => {
    const policy = mt5PolicySchema.parse(rawPolicy)

    if (getRiskBudgetBase(state) <= 0) {
        return ALLOWED_VALIDATION_RESULT
    }

    const riskPercent = intent.metadata?.riskPercent as number | undefined
    if (riskPercent === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "mt5.maxRiskPercent",
        observed: riskPercent,
        threshold: policy.maxRiskPercent,
        comparison: "max",
    })

    if (riskPercent > policy.maxRiskPercent) {
        return rejectRiskWithGateEvaluation(
            `Risk ${riskPercent.toFixed(1)}% exceeds max ${policy.maxRiskPercent}%`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

const tradingHoursValidator: RiskValidator = openIntentRiskValidator((_intent, rawPolicy) => {
    const policy = mt5PolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours

    return validateTradingHoursWindow({ start, end, timezone, gateKey: "mt5.tradingHours" })
})

const entryCutoffValidator: RiskValidator = openIntentRiskValidator((intent, rawPolicy) => {
    const policy = mt5PolicySchema.parse(rawPolicy)

    if (policy.entryCutoffMinutesBeforeSessionEnd === undefined) {
        return ALLOWED_VALIDATION_RESULT
    }

    if (getIntentAction(intent) !== "entry") {
        return ALLOWED_VALIDATION_RESULT
    }

    const { start, end, timezone } = policy.tradingHours
    const windowState = resolveTradingHoursWindowState({ start, end, timezone })

    if (!windowState.withinWindow) {
        return ALLOWED_VALIDATION_RESULT
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "mt5.entryCutoffMinutesBeforeSessionEnd",
        observed: windowState.minutesUntilEnd,
        threshold: policy.entryCutoffMinutesBeforeSessionEnd,
        comparison: "min",
        scale: policy.entryCutoffMinutesBeforeSessionEnd,
    })

    if (windowState.minutesUntilEnd <= policy.entryCutoffMinutesBeforeSessionEnd) {
        return rejectRiskWithGateEvaluation(
            `MT5 entry cutoff active: ${windowState.minutesUntilEnd} minutes remain before tradingHours.end ${end} ${timezone}; cutoff is ${policy.entryCutoffMinutesBeforeSessionEnd} minutes.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

export const mt5RiskValidators: readonly RiskValidator[] = [
    slTpRequiredValidator,
    minRiskRewardValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
    entryCutoffValidator,
    minStopDistanceSpreadMultipleValidator,
]
