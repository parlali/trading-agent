import { getRiskBudgetBase, getCurrentTimeInTimezone, mt5PolicySchema, padTime, } from "@valiq-trading/core";
export const mt5RiskValidators = [
    slTpRequiredValidator,
    minRiskRewardValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
    emergencyFlattenValidator,
];
function slTpRequiredValidator(intent, _rawPolicy, _state, _positions) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const sl = intent.metadata?.stopLoss;
    const tp = intent.metadata?.takeProfit;
    if (sl === undefined || sl === null) {
        return {
            allowed: false,
            reason: "MT5 orders require a stopLoss. Provide stopLoss with your order.",
        };
    }
    if (tp === undefined || tp === null) {
        return {
            allowed: false,
            reason: "MT5 orders require a takeProfit. Provide takeProfit (or riskRewardRatio) with your order.",
        };
    }
    return { allowed: true };
}
function minRiskRewardValidator(intent, rawPolicy, _state, _positions) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = mt5PolicySchema.parse(rawPolicy);
    const impliedRR = intent.metadata?.impliedRR;
    if (impliedRR === undefined) {
        return { allowed: true };
    }
    if (impliedRR < policy.minRiskReward) {
        return {
            allowed: false,
            reason: `Risk-reward ratio ${impliedRR.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your TP or tighten your SL.`,
        };
    }
    return { allowed: true };
}
function maxRiskPercentValidator(intent, rawPolicy, state, _positions) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = mt5PolicySchema.parse(rawPolicy);
    if (getRiskBudgetBase(state) <= 0) {
        return { allowed: true };
    }
    const riskPercent = intent.metadata?.riskPercent;
    if (riskPercent === undefined) {
        return { allowed: true };
    }
    if (riskPercent > policy.maxRiskPercent) {
        return {
            allowed: false,
            reason: `Risk ${riskPercent.toFixed(1)}% exceeds max ${policy.maxRiskPercent}%`,
        };
    }
    return { allowed: true };
}
function tradingHoursValidator(intent, rawPolicy) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = mt5PolicySchema.parse(rawPolicy);
    const { start, end, timezone } = policy.tradingHours;
    const now = getCurrentTimeInTimezone(timezone);
    const [startHour, startMinute] = start.split(":").map(Number);
    const [endHour, endMinute] = end.split(":").map(Number);
    const currentMinutes = now.hours * 60 + now.minutes;
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;
    let withinWindow;
    if (startMinutes <= endMinutes) {
        withinWindow = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    else {
        withinWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    if (!withinWindow) {
        return {
            allowed: false,
            reason: `Outside trading hours. Current time: ${padTime(now.hours)}:${padTime(now.minutes)} ${timezone}. Allowed: ${start}-${end}`,
        };
    }
    return { allowed: true };
}
function emergencyFlattenValidator(intent, rawPolicy, state) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = mt5PolicySchema.parse(rawPolicy);
    if (state.openPnl < 0 && Math.abs(state.openPnl) >= policy.emergencyFlattenThreshold) {
        return {
            allowed: false,
            reason: `Unrealized loss ${Math.abs(state.openPnl).toFixed(2)} exceeds emergency flatten threshold ${policy.emergencyFlattenThreshold}. Close positions first.`,
        };
    }
    return { allowed: true };
}
function isCloseAction(intent) {
    const action = intent.metadata?.action;
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order";
}
