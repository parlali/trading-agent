import type { OrderIntent, AccountState, Position, ValidationResult } from "./types"

export type RiskValidator = (
    intent: OrderIntent,
    policy: Record<string, unknown>,
    state: AccountState,
    positions: Position[]
) => ValidationResult

export const duplicateOrderValidator: RiskValidator = (intent, _policy, _state, positions) => {
    const intentSide = intent.side === "buy" ? "long" : "short"

    const duplicate = positions.find(
        (pos) => pos.instrument === intent.instrument && pos.side === intentSide
    )

    if (duplicate) {
        return {
            allowed: false,
            reason: `Duplicate: already have ${intentSide} position in ${intent.instrument} (qty: ${duplicate.quantity})`,
        }
    }
    return { allowed: true }
}

export const BASE_RISK_VALIDATORS: readonly RiskValidator[] = [
    duplicateOrderValidator,
]

export function validateIntent(
    intent: OrderIntent,
    policy: Record<string, unknown>,
    state: AccountState,
    positions: Position[],
    validators: readonly RiskValidator[] = BASE_RISK_VALIDATORS
): ValidationResult {
    for (const validator of validators) {
        const result = validator(intent, policy, state, positions)
        if (!result.allowed) {
            return result
        }
    }

    return { allowed: true }
}

export class RiskEngine {
    private validators: readonly RiskValidator[]

    constructor(validators: readonly RiskValidator[] = BASE_RISK_VALIDATORS) {
        this.validators = [...validators]
    }

    validate(
        intent: OrderIntent,
        policy: Record<string, unknown>,
        state: AccountState,
        positions: Position[]
    ): ValidationResult {
        return validateIntent(intent, policy, state, positions, this.validators)
    }

    getValidators(): readonly RiskValidator[] {
        return this.validators
    }
}

export function createRiskEngine(validators: readonly RiskValidator[] = BASE_RISK_VALIDATORS): RiskEngine {
    return new RiskEngine(validators)
}

export function createInstrumentConflictValidator(
    globallyClaimedInstruments: Map<string, string>
): RiskValidator {
    return (intent, _policy, _state, _positions) => {
        const action = intent.metadata?.action
        if (action !== "entry" && action !== undefined) {
            return { allowed: true }
        }

        const owner = globallyClaimedInstruments.get(intent.instrument)
        if (!owner) {
            return { allowed: true }
        }

        return {
            allowed: false,
            reason: `Instrument conflict: ${intent.instrument} is already owned by strategy ${owner}`,
        }
    }
}
