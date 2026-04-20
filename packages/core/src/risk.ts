import type { OrderAction } from "./orders"
import type {
    OrderIntent,
    AccountState,
    Position,
    ValidationResult,
    StrategySafetyState,
} from "./types"

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

export function getIntentLifecycleAction(intent: OrderIntent): OrderAction | undefined {
    const action = intent.metadata?.action
    if (
        action === "entry" ||
        action === "adjustment" ||
        action === "close" ||
        action === "modify" ||
        action === "cancel"
    ) {
        return action
    }
    return undefined
}

export function isRiskReducingAction(action: OrderAction | undefined): boolean {
    return action === "close" || action === "cancel"
}

export function isRiskReducingIntent(intent: OrderIntent): boolean {
    const action = getIntentLifecycleAction(intent)
    if (isRiskReducingAction(action)) {
        return true
    }

    if (action === "modify" || action === "adjustment") {
        return intent.metadata?.riskReducing === true
    }

    return false
}

export function createStrategySafetyValidator(args: {
    safetyState: StrategySafetyState
    blockedInstruments?: Set<string>
    reason?: string
}): RiskValidator {
    return (intent) => {
        if (isRiskReducingIntent(intent)) {
            return { allowed: true }
        }

        if (args.blockedInstruments?.has(intent.instrument)) {
            return {
                allowed: false,
                reason: `Instrument ${intent.instrument} is blocked due to unresolved execution safety faults. Only risk-reducing actions are allowed until provider state is clean.`,
            }
        }

        if (args.safetyState === "healthy") {
            return { allowed: true }
        }

        if (args.safetyState === "blocked") {
            return {
                allowed: false,
                reason: args.reason ?? "Strategy is safety-blocked. New risk is disabled until execution safety faults are resolved.",
            }
        }

        if (args.safetyState === "cooldown") {
            return {
                allowed: false,
                reason: args.reason ?? "Strategy is in drawdown cooldown. New entries and size-ins are blocked.",
            }
        }

        if (args.safetyState === "execution_degraded") {
            if ((args.blockedInstruments?.size ?? 0) > 0) {
                return { allowed: true }
            }
            return {
                allowed: false,
                reason: args.reason ?? "Strategy is execution-degraded. New risk is blocked while preserving risk-reducing actions.",
            }
        }

        return {
            allowed: false,
            reason: args.reason ?? "Strategy is safety-blocked. New risk is disabled until execution safety faults are resolved.",
        }
    }
}

export function validateIntent(
    intent: OrderIntent,
    policy: Record<string, unknown>,
    state: AccountState,
    positions: Position[],
    validators: readonly RiskValidator[] = BASE_RISK_VALIDATORS
): ValidationResult {
    let currentIntent = intent

    for (const validator of validators) {
        const result = validator(currentIntent, policy, state, positions)
        if (!result.allowed) {
            return result
        }

        if (result.adjustedIntent) {
            currentIntent = result.adjustedIntent
        }
    }

    return currentIntent === intent
        ? { allowed: true }
        : {
            allowed: true,
            adjustedIntent: currentIntent,
        }
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
