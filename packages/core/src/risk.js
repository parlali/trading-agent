export const duplicateOrderValidator = (intent, _policy, _state, positions) => {
    const intentSide = intent.side === "buy" ? "long" : "short";
    const duplicate = positions.find((pos) => pos.instrument === intent.instrument && pos.side === intentSide);
    if (duplicate) {
        return {
            allowed: false,
            reason: `Duplicate: already have ${intentSide} position in ${intent.instrument} (qty: ${duplicate.quantity})`,
        };
    }
    return { allowed: true };
};
export const BASE_RISK_VALIDATORS = [
    duplicateOrderValidator,
];
export function validateIntent(intent, policy, state, positions, validators = BASE_RISK_VALIDATORS) {
    let currentIntent = intent;
    for (const validator of validators) {
        const result = validator(currentIntent, policy, state, positions);
        if (!result.allowed) {
            return result;
        }
        if (result.adjustedIntent) {
            currentIntent = result.adjustedIntent;
        }
    }
    return currentIntent === intent
        ? { allowed: true }
        : {
            allowed: true,
            adjustedIntent: currentIntent,
        };
}
export class RiskEngine {
    validators;
    constructor(validators = BASE_RISK_VALIDATORS) {
        this.validators = [...validators];
    }
    validate(intent, policy, state, positions) {
        return validateIntent(intent, policy, state, positions, this.validators);
    }
    getValidators() {
        return this.validators;
    }
}
export function createRiskEngine(validators = BASE_RISK_VALIDATORS) {
    return new RiskEngine(validators);
}
export function createInstrumentConflictValidator(globallyClaimedInstruments) {
    return (intent, _policy, _state, _positions) => {
        const action = intent.metadata?.action;
        if (action !== "entry" && action !== undefined) {
            return { allowed: true };
        }
        const owner = globallyClaimedInstruments.get(intent.instrument);
        if (!owner) {
            return { allowed: true };
        }
        return {
            allowed: false,
            reason: `Instrument conflict: ${intent.instrument} is already owned by strategy ${owner}`,
        };
    };
}
