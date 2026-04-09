import { getRiskBudgetBase, polymarketPolicySchema, } from "@valiq-trading/core";
export const polymarketRiskValidators = [
    maxBetValidator,
    priceBoundsValidator,
];
function maxBetValidator(intent, rawPolicy, state, _positions) {
    const policy = polymarketPolicySchema.parse(rawPolicy);
    if (intent.side === "sell") {
        return { allowed: true };
    }
    const price = intent.limitPrice ?? 0;
    const intentCost = intent.quantity * price;
    let maxAllowed;
    if (policy.maxBet.mode === "fixed") {
        maxAllowed = policy.maxBet.value;
    }
    else {
        maxAllowed = (policy.maxBet.value / 100) * getRiskBudgetBase(state);
    }
    if (intentCost > maxAllowed) {
        const modeLabel = policy.maxBet.mode === "fixed"
            ? `$${policy.maxBet.value}`
            : `${policy.maxBet.value}% of balance ($${maxAllowed.toFixed(2)})`;
        return {
            allowed: false,
            reason: `Bet cost $${intentCost.toFixed(2)} exceeds max bet ${modeLabel}`,
        };
    }
    return { allowed: true };
}
const PRICE_LOWER_BOUND = 0.02;
const PRICE_UPPER_BOUND = 0.82;
function priceBoundsValidator(intent) {
    if (intent.side === "sell") {
        return { allowed: true };
    }
    const price = intent.limitPrice;
    if (price === undefined || price <= 0) {
        return { allowed: true };
    }
    if (price < PRICE_LOWER_BOUND) {
        return {
            allowed: false,
            reason: `Buy price ${price} is below the safety floor ${PRICE_LOWER_BOUND} -- near-zero probability markets carry extreme risk`,
        };
    }
    if (price > PRICE_UPPER_BOUND) {
        return {
            allowed: false,
            reason: `Buy price ${price} exceeds the safety ceiling ${PRICE_UPPER_BOUND} -- near-certain markets offer minimal upside`,
        };
    }
    return { allowed: true };
}
