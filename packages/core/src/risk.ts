import type { OrderIntent, AccountState, Position, ValidationResult } from "./types"

export type RiskValidator = (
    intent: OrderIntent,
    policy: Record<string, unknown>,
    state: AccountState,
    positions: Position[]
) => ValidationResult

export const balanceFloorValidator: RiskValidator = (_intent, policy, state) => {
    const floor = (policy.balanceFloor as number) ?? 0
    if (state.balance <= floor) {
        return {
            allowed: false,
            reason: `Account balance ${state.balance} is at or below floor ${floor}`,
        }
    }
    return { allowed: true }
}

export const maxLossPerTradeValidator: RiskValidator = (intent, policy) => {
    const maxLoss = policy.maxLossPerTrade as number | undefined
    if (maxLoss === undefined) return { allowed: true }

    let estimatedLoss: number

    if (intent.legs && intent.legs.length > 0) {
        let maxDebit = 0
        for (const leg of intent.legs) {
            const price = leg.limitPrice ?? 0
            maxDebit += price * leg.quantity
        }
        estimatedLoss = maxDebit
    } else {
        const price = intent.limitPrice ?? intent.stopPrice ?? 0
        estimatedLoss = intent.quantity * price
    }

    if (estimatedLoss > maxLoss) {
        return {
            allowed: false,
            reason: `Estimated loss ${estimatedLoss} exceeds max loss per trade ${maxLoss}`,
        }
    }
    return { allowed: true }
}

export const maxTotalExposureValidator: RiskValidator = (intent, policy, _state, positions) => {
    const maxExposure = policy.maxTotalExposure as number | undefined
    if (maxExposure === undefined) return { allowed: true }

    let currentExposure = 0
    for (const pos of positions) {
        currentExposure += Math.abs(pos.quantity * pos.entryPrice)
    }

    const price = intent.limitPrice ?? intent.stopPrice ?? 0
    const newExposure = intent.quantity * price
    const totalExposure = currentExposure + newExposure

    if (totalExposure > maxExposure) {
        return {
            allowed: false,
            reason: `Total exposure ${totalExposure} would exceed max ${maxExposure} (current: ${currentExposure}, new: ${newExposure})`,
        }
    }
    return { allowed: true }
}

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
    balanceFloorValidator,
    maxLossPerTradeValidator,
    maxTotalExposureValidator,
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
