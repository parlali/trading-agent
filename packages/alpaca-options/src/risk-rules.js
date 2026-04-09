import { alpacaOptionsPolicySchema, getIntentAction, } from "@valiq-trading/core";
const SUPPORTED_ALPACA_ORDER_TYPE = "limit";
const SUPPORTED_ALPACA_TIME_IN_FORCE = "day";
export const alpacaRiskValidators = [
    ironCondorStructureValidator,
    maxLossPerPlayValidator,
    expiryValidationValidator,
    spreadWidthValidationValidator,
];
export function buildIronCondorInstrument(underlying, expiration, quantity) {
    return `IC:${underlying.toUpperCase()}:${expiration}:${quantity}`;
}
export function parseOptionContractSymbol(symbol) {
    const normalized = symbol.trim().toUpperCase();
    if (normalized.length < 15) {
        return null;
    }
    const suffix = normalized.slice(-15);
    const underlying = normalized.slice(0, -15).trim();
    const datePart = suffix.slice(0, 6);
    const typePart = suffix.slice(6, 7);
    const strikePart = suffix.slice(7);
    if (!/^\d{6}$/.test(datePart) || !/^\d{8}$/.test(strikePart) || (typePart !== "C" && typePart !== "P")) {
        return null;
    }
    const year = `20${datePart.slice(0, 2)}`;
    const month = datePart.slice(2, 4);
    const day = datePart.slice(4, 6);
    return {
        underlying,
        expiration: `${year}-${month}-${day}`,
        optionType: typePart === "C" ? "call" : "put",
        strike: Number(strikePart) / 1000,
    };
}
function ironCondorStructureValidator(intent) {
    const action = getIntentAction(intent);
    if (action === "adjustment") {
        return {
            allowed: false,
            reason: "Alpaca options adjustments are not supported for this strategy path. Use modify_order for working entries or propose_close for filled structures.",
        };
    }
    if (!intent.legs || intent.legs.length === 0) {
        return {
            allowed: false,
            reason: "Alpaca options orders must be submitted as exactly 4 option legs",
        };
    }
    if (intent.legs.length !== 4) {
        return {
            allowed: false,
            reason: "Alpaca iron condor orders must contain exactly 4 legs",
        };
    }
    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        return {
            allowed: false,
            reason: "Alpaca iron condor orders require a positive integer structure quantity",
        };
    }
    if (intent.orderType !== SUPPORTED_ALPACA_ORDER_TYPE) {
        return {
            allowed: false,
            reason: "Alpaca iron condor orders only support limit pricing",
        };
    }
    if (intent.timeInForce !== SUPPORTED_ALPACA_TIME_IN_FORCE) {
        return {
            allowed: false,
            reason: "Alpaca iron condor orders only support day time in force",
        };
    }
    if (intent.stopPrice !== undefined) {
        return {
            allowed: false,
            reason: "Alpaca iron condor orders do not support stop prices",
        };
    }
    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        return {
            allowed: false,
            reason: "Alpaca iron condor orders require a positive net credit/debit limit price",
        };
    }
    if (intent.legs.some((leg) => leg.limitPrice !== undefined)) {
        return {
            allowed: false,
            reason: "Per-leg limit prices are not supported for Alpaca iron condor orders",
        };
    }
    const normalizedLegs = normalizeOptionLegs(intent);
    if (!Array.isArray(normalizedLegs)) {
        return normalizedLegs;
    }
    const expirations = new Set(normalizedLegs.map((leg) => leg.expiration));
    if (expirations.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same expiration",
        };
    }
    const underlyings = new Set(normalizedLegs.map((leg) => leg.underlying));
    if (underlyings.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca iron condor must share the same underlying",
        };
    }
    const calls = normalizedLegs.filter((leg) => leg.optionType === "call");
    const puts = normalizedLegs.filter((leg) => leg.optionType === "put");
    const buys = normalizedLegs.filter((leg) => leg.direction === "buy");
    const sells = normalizedLegs.filter((leg) => leg.direction === "sell");
    if (calls.length !== 2 || puts.length !== 2 || buys.length !== 2 || sells.length !== 2) {
        return {
            allowed: false,
            reason: "Alpaca iron condor entries must have 2 calls, 2 puts, 2 buys, and 2 sells",
        };
    }
    const expectedEffect = action === "close" ? "close" : "open";
    if (normalizedLegs.some((leg) => leg.positionEffect !== expectedEffect)) {
        return {
            allowed: false,
            reason: action === "close"
                ? "Closing a structure requires buy_to_close/sell_to_close legs"
                : "Opening a structure requires buy_to_open/sell_to_open legs",
        };
    }
    if (!isIronCondorGeometry(calls, puts)) {
        return {
            allowed: false,
            reason: "Leg strikes do not form a valid iron condor geometry",
        };
    }
    if (!hasSupportedLegRatios(intent, normalizedLegs)) {
        return {
            allowed: false,
            reason: "Each Alpaca iron condor leg must use a 1-lot ratio matching the top-level structure quantity",
        };
    }
    const expiration = normalizedLegs[0]?.expiration ?? "";
    const underlying = normalizedLegs[0]?.underlying ?? intent.instrument;
    const spreadWidth = calculateNormalizedStructureWidth(normalizedLegs);
    return {
        allowed: true,
        adjustedIntent: {
            ...intent,
            instrument: buildIronCondorInstrument(underlying, expiration, intent.quantity),
            side: action === "close" ? "buy" : "sell",
            orderType: SUPPORTED_ALPACA_ORDER_TYPE,
            timeInForce: SUPPORTED_ALPACA_TIME_IN_FORCE,
            stopPrice: undefined,
            legs: normalizedLegs.map((leg) => ({
                instrument: leg.instrument,
                side: leg.side,
                quantity: 1,
            })),
            metadata: {
                ...intent.metadata,
                action,
                structureType: "iron_condor",
                underlying,
                expiration,
                expectedExpiration: expiration,
                spreadWidth,
            },
        },
    };
}
function maxLossPerPlayValidator(intent, rawPolicy, _state, _positions) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy);
    const estimatedMaxLoss = estimateStructureMaxLoss(intent);
    if (estimatedMaxLoss === null) {
        return {
            allowed: false,
            reason: "Unable to determine max loss for Alpaca options structure",
        };
    }
    if (estimatedMaxLoss > policy.maxLossPerPlay) {
        return {
            allowed: false,
            reason: `Estimated max loss ${estimatedMaxLoss} exceeds limit ${policy.maxLossPerPlay}`,
        };
    }
    return { allowed: true };
}
function expiryValidationValidator(intent) {
    const expirations = getIntentExpirations(intent);
    if (expirations.length === 0) {
        return {
            allowed: false,
            reason: "Unable to determine option expiration for Alpaca multi-leg order",
        };
    }
    const uniqueExpirations = new Set(expirations);
    if (uniqueExpirations.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same expiration",
        };
    }
    const expectedExpiration = intent.metadata?.expectedExpiration;
    if (typeof expectedExpiration === "string" && !uniqueExpirations.has(expectedExpiration)) {
        return {
            allowed: false,
            reason: `Order expiration ${expirations[0]} does not match expected expiration ${expectedExpiration}`,
        };
    }
    const targetDaysToExpiry = intent.metadata?.targetDaysToExpiry;
    if (typeof targetDaysToExpiry === "number") {
        const actualDays = diffDays(expirations[0] ?? "");
        if (actualDays === null || actualDays !== targetDaysToExpiry) {
            return {
                allowed: false,
                reason: `Order expiration is ${actualDays ?? "unknown"} DTE but strategy expects ${targetDaysToExpiry} DTE`,
            };
        }
    }
    return { allowed: true };
}
function spreadWidthValidationValidator(intent, rawPolicy) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy);
    const width = calculateStructureWidth(intent);
    if (width === null) {
        return {
            allowed: false,
            reason: "Unable to determine spread width for Alpaca options structure",
        };
    }
    const maxLossFromWidth = width * 100 * intent.quantity;
    if (maxLossFromWidth > policy.maxLossPerPlay) {
        return {
            allowed: false,
            reason: `Spread width implies max loss ${maxLossFromWidth}, exceeding ${policy.maxLossPerPlay}`,
        };
    }
    return { allowed: true };
}
function getIntentExpirations(intent) {
    if (!intent.legs || intent.legs.length === 0) {
        return [];
    }
    return intent.legs
        .map((leg) => parseOptionContractSymbol(leg.instrument)?.expiration)
        .filter((value) => Boolean(value));
}
function calculateStructureWidth(intent) {
    const normalizedLegs = normalizeOptionLegs(intent);
    if (!Array.isArray(normalizedLegs) || normalizedLegs.length < 4) {
        const metadataWidth = intent.metadata?.spreadWidth;
        return typeof metadataWidth === "number" ? metadataWidth : null;
    }
    return calculateNormalizedStructureWidth(normalizedLegs);
}
function estimateStructureMaxLoss(intent) {
    const explicitMaxLoss = intent.metadata?.maxLoss;
    if (typeof explicitMaxLoss === "number") {
        return explicitMaxLoss;
    }
    const width = calculateStructureWidth(intent);
    if (width === null) {
        return null;
    }
    const credit = intent.limitPrice ?? 0;
    const grossRisk = width * 100 * intent.quantity;
    const creditOffset = credit * 100 * intent.quantity;
    return Math.max(grossRisk - creditOffset, 0);
}
function diffDays(expiration) {
    const expirationAt = new Date(`${expiration}T00:00:00Z`);
    if (Number.isNaN(expirationAt.getTime())) {
        return null;
    }
    const difference = expirationAt.getTime() - Date.now();
    return Math.round(difference / 86_400_000);
}
function normalizeOptionLegs(intent) {
    const action = getIntentAction(intent);
    const normalizedLegs = [];
    for (const leg of intent.legs ?? []) {
        const parsed = parseOptionContractSymbol(leg.instrument);
        if (!parsed) {
            return {
                allowed: false,
                reason: `Invalid OCC option symbol: ${leg.instrument}`,
            };
        }
        const normalizedSide = normalizeLegSide(leg.side, action);
        if (!normalizedSide) {
            return {
                allowed: false,
                reason: `Unsupported Alpaca leg side ${leg.side} for ${action} orders`,
            };
        }
        normalizedLegs.push({
            ...parsed,
            instrument: leg.instrument,
            quantity: leg.quantity,
            side: normalizedSide,
            direction: normalizedSide.startsWith("buy") ? "buy" : "sell",
            positionEffect: normalizedSide.endsWith("_close") ? "close" : "open",
        });
    }
    return normalizedLegs;
}
function normalizeLegSide(side, action) {
    if (side === "buy_to_open" ||
        side === "sell_to_open" ||
        side === "buy_to_close" ||
        side === "sell_to_close") {
        return side;
    }
    if (side === "buy") {
        return action === "close" ? "buy_to_close" : "buy_to_open";
    }
    if (side === "sell") {
        return action === "close" ? "sell_to_close" : "sell_to_open";
    }
    return null;
}
function hasSupportedLegRatios(intent, legs) {
    return legs.every((leg) => Number.isInteger(leg.quantity) && (leg.quantity === 1 || leg.quantity === intent.quantity));
}
function isIronCondorGeometry(calls, puts) {
    const shortCall = calls.find((leg) => leg.direction === "sell");
    const longCall = calls.find((leg) => leg.direction === "buy");
    const shortPut = puts.find((leg) => leg.direction === "sell");
    const longPut = puts.find((leg) => leg.direction === "buy");
    if (!shortCall || !longCall || !shortPut || !longPut) {
        return false;
    }
    return (longPut.strike < shortPut.strike &&
        shortPut.strike < shortCall.strike &&
        shortCall.strike < longCall.strike);
}
function calculateNormalizedStructureWidth(legs) {
    const callStrikes = legs
        .filter((leg) => leg.optionType === "call")
        .map((leg) => leg.strike)
        .sort((left, right) => left - right);
    const putStrikes = legs
        .filter((leg) => leg.optionType === "put")
        .map((leg) => leg.strike)
        .sort((left, right) => left - right);
    const callWidth = callStrikes.length >= 2 ? callStrikes[callStrikes.length - 1] - callStrikes[0] : 0;
    const putWidth = putStrikes.length >= 2 ? putStrikes[putStrikes.length - 1] - putStrikes[0] : 0;
    const width = Math.max(callWidth, putWidth);
    return width > 0 ? width : null;
}
