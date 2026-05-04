import {
    ALLOWED_VALIDATION_RESULT,
    getRiskBudgetBase,
    mt5PolicySchema,
    openIntentRiskValidator,
    rejectRisk,
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

    if (impliedRR < policy.minRiskReward) {
        return rejectRisk(`Risk-reward ratio ${impliedRR.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your TP or tighten your SL.`)
    }

    return ALLOWED_VALIDATION_RESULT
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

    if (riskPercent > policy.maxRiskPercent) {
        return rejectRisk(`Risk ${riskPercent.toFixed(1)}% exceeds max ${policy.maxRiskPercent}%`)
    }

    return ALLOWED_VALIDATION_RESULT
})

const tradingHoursValidator: RiskValidator = openIntentRiskValidator((_intent, rawPolicy) => {
    const policy = mt5PolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours

    return validateTradingHoursWindow({ start, end, timezone })
})

export const mt5RiskValidators: readonly RiskValidator[] = [
    slTpRequiredValidator,
    minRiskRewardValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
]
