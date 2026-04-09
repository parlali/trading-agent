import { binancePolicySchema, getCurrentTimeInTimezone, padTime, } from "@valiq-trading/core";
export const binanceRiskValidators = [
    allowedInstrumentsValidator,
    slTpRequiredValidator,
    maxLeverageValidator,
    maxRiskPercentValidator,
    tradingHoursValidator,
    emergencyFlattenValidator,
    fundingRateValidator,
];
function allowedInstrumentsValidator(intent, rawPolicy) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = binancePolicySchema.parse(rawPolicy);
    const allowed = new Set(policy.allowedInstruments.map((instrument) => instrument.toUpperCase()));
    const symbol = intent.instrument.toUpperCase();
    if (!allowed.has(symbol)) {
        return {
            allowed: false,
            reason: `Instrument ${symbol} is not in allowedInstruments: ${policy.allowedInstruments.join(", ")}`,
        };
    }
    return { allowed: true };
}
function slTpRequiredValidator(intent, rawPolicy, _state, _positions) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = binancePolicySchema.parse(rawPolicy);
    const stopLoss = intent.metadata?.stopLoss;
    const takeProfit = intent.metadata?.takeProfit;
    if (stopLoss === undefined || stopLoss === null) {
        return {
            allowed: false,
            reason: "Binance futures entries require stopLoss",
        };
    }
    if (policy.requireTakeProfit && (takeProfit === undefined || takeProfit === null)) {
        return {
            allowed: false,
            reason: "Binance policy requires takeProfit for new entries",
        };
    }
    return { allowed: true };
}
function maxLeverageValidator(intent, rawPolicy) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = binancePolicySchema.parse(rawPolicy);
    const leverage = intent.metadata?.leverage;
    if (leverage === undefined) {
        return { allowed: true };
    }
    if (leverage > policy.maxLeverage) {
        return {
            allowed: false,
            reason: `Leverage ${leverage}x exceeds configured maxLeverage ${policy.maxLeverage}x`,
        };
    }
    return { allowed: true };
}
function maxRiskPercentValidator(intent, rawPolicy, _state, _positions) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = binancePolicySchema.parse(rawPolicy);
    const riskPercent = intent.metadata?.riskPercent;
    if (riskPercent === undefined) {
        return { allowed: true };
    }
    if (riskPercent > policy.maxRiskPercent) {
        return {
            allowed: false,
            reason: `Risk ${riskPercent.toFixed(2)}% exceeds maxRiskPercent ${policy.maxRiskPercent}%`,
        };
    }
    return { allowed: true };
}
function tradingHoursValidator(intent, rawPolicy) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = binancePolicySchema.parse(rawPolicy);
    const { start, end, timezone } = policy.tradingHours;
    const now = getCurrentTimeInTimezone(timezone);
    const [startHour, startMinute] = start.split(":").map(Number);
    const [endHour, endMinute] = end.split(":").map(Number);
    const currentMinutes = now.hours * 60 + now.minutes;
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;
    const withinWindow = startMinutes <= endMinutes
        ? currentMinutes >= startMinutes && currentMinutes < endMinutes
        : currentMinutes >= startMinutes || currentMinutes < endMinutes;
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
    const policy = binancePolicySchema.parse(rawPolicy);
    if (state.openPnl < 0 && Math.abs(state.openPnl) >= policy.emergencyFlattenThreshold) {
        return {
            allowed: false,
            reason: `Unrealized loss ${Math.abs(state.openPnl).toFixed(2)} exceeds emergencyFlattenThreshold ${policy.emergencyFlattenThreshold}`,
        };
    }
    return { allowed: true };
}
function fundingRateValidator(intent, rawPolicy) {
    if (isCloseAction(intent)) {
        return { allowed: true };
    }
    const policy = binancePolicySchema.parse(rawPolicy);
    const fundingRate = intent.metadata?.fundingRate;
    if (fundingRate === undefined) {
        return { allowed: true };
    }
    if (Math.abs(fundingRate) > policy.fundingRateThreshold) {
        return {
            allowed: false,
            reason: `Funding rate ${fundingRate.toFixed(6)} exceeds threshold ${policy.fundingRateThreshold.toFixed(6)}`,
        };
    }
    return { allowed: true };
}
function isCloseAction(intent) {
    const action = intent.metadata?.action;
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order";
}
