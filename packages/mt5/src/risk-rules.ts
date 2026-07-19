import {
    ALLOWED_VALIDATION_RESULT,
    allowWithGateEvaluation,
    createGateEvaluation,
    getRiskBudgetBase,
    mt5PolicySchema,
    openIntentRiskValidator,
    rejectRisk,
    rejectRiskWithGateEvaluation,
    validateTradingHoursWindow,
    type RiskValidator,
} from "@valiq-trading/core"

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

export const mt5RiskValidators: readonly RiskValidator[] = [
    slTpRequiredValidator,
    minRiskRewardValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
]
