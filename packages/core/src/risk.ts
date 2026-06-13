import { getCurrentTimeInTimezone, padTime } from "./runtime-time"
import type {
    OrderIntent,
    AccountState,
    Position,
    ValidationResult,
    StrategySafetyState,
} from "./types"
import type { RiskValidator } from "./risk-types"
import { getIntentAction } from "./intent"
import {
    isCloseOrCancelIntent,
    isRiskReducingAction,
    isRiskReducingIntent,
} from "./risk-intents"

export type { RiskValidator } from "./risk-types"
export {
    getIntentLifecycleAction,
    isCloseOrCancelIntent,
    isRiskReducingAction,
    isRiskReducingIntent,
} from "./risk-intents"

export const ALLOWED_VALIDATION_RESULT = { allowed: true } as const

export function rejectRisk(reason: string): { allowed: false; reason: string } {
    return { allowed: false, reason }
}

export const POLYMARKET_CONDITION_ALIAS_PREFIX = "polymarket-condition:"

export function readPolymarketConditionId(metadata: unknown): string | undefined {
    if (!metadata || typeof metadata !== "object") {
        return undefined
    }

    const candidate = (metadata as Record<string, unknown>).conditionId
    if (typeof candidate !== "string") {
        return undefined
    }

    const normalized = candidate.trim()
    return normalized.length > 0 ? normalized : undefined
}

export function buildPolymarketConditionInstrumentAlias(conditionId: unknown): string | undefined {
    if (typeof conditionId !== "string") {
        return undefined
    }

    const normalized = conditionId.trim()
    return normalized.length > 0
        ? `${POLYMARKET_CONDITION_ALIAS_PREFIX}${normalized}`
        : undefined
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

    if (intent.side === "buy") {
        const intentConditionId = readPolymarketConditionId(intent.metadata)
        const conditionDuplicate = intentConditionId !== undefined
            ? positions.find((pos) =>
                pos.instrument !== intent.instrument &&
                readPolymarketConditionId(pos.metadata) === intentConditionId
            )
            : undefined

        if (conditionDuplicate) {
            return {
                allowed: false,
                reason: `Duplicate: market ${intentConditionId} is already exposed through outcome token ${conditionDuplicate.instrument} (qty: ${conditionDuplicate.quantity})`,
            }
        }
    }

    return { allowed: true }
}

export const BASE_RISK_VALIDATORS: readonly RiskValidator[] = [
    duplicateOrderValidator,
]

export function openIntentRiskValidator(validate: RiskValidator): RiskValidator {
    return (intent, policy, state, positions) => {
        if (isCloseOrCancelIntent(intent)) {
            return ALLOWED_VALIDATION_RESULT
        }

        return validate(intent, policy, state, positions)
    }
}

export function validateTradingHoursWindow(args: {
    start: string
    end: string
    timezone: string
}): ValidationResult {
    const now = getCurrentTimeInTimezone(args.timezone)
    const [startHour, startMinute] = args.start.split(":").map(Number) as [number, number]
    const [endHour, endMinute] = args.end.split(":").map(Number) as [number, number]

    const currentMinutes = now.hours * 60 + now.minutes
    const startMinutes = startHour * 60 + startMinute
    const endMinutes = endHour * 60 + endMinute

    const withinWindow = startMinutes <= endMinutes
        ? currentMinutes >= startMinutes && currentMinutes < endMinutes
        : currentMinutes >= startMinutes || currentMinutes < endMinutes

    if (!withinWindow) {
        return rejectRisk(
            `Outside trading hours. Current time: ${padTime(now.hours)}:${padTime(now.minutes)} ${args.timezone}. Allowed: ${args.start}-${args.end}`
        )
    }

    return ALLOWED_VALIDATION_RESULT
}

export function createStrategySafetyValidator(args: {
    safetyState: StrategySafetyState
    blockedInstruments?: Set<string>
    reason?: string
    blockedInstrumentReason?: string
}): RiskValidator {
    return (intent) => {
        if (isRiskReducingIntent(intent)) {
            return { allowed: true }
        }

        if (args.blockedInstruments?.has(intent.instrument)) {
            return {
                allowed: false,
                reason: args.blockedInstrumentReason ??
                    args.reason ??
                    `Instrument ${intent.instrument} is blocked by strategy safety governance. Only risk-reducing actions are allowed until provider state is clean.`,
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
        const action = getIntentAction(intent)
        if (isRiskReducingAction(action)) {
            return { allowed: true }
        }

        const conditionAlias = buildPolymarketConditionInstrumentAlias(
            readPolymarketConditionId(intent.metadata)
        )
        const claimKeys = conditionAlias !== undefined
            ? [intent.instrument, conditionAlias]
            : [intent.instrument]

        for (const claimKey of claimKeys) {
            const owner = globallyClaimedInstruments.get(claimKey)
            if (owner) {
                return {
                    allowed: false,
                    reason: `Instrument conflict: ${claimKey} is already owned by strategy ${owner} and this ${action} intent would add or modify exposure on it`,
                }
            }
        }

        return { allowed: true }
    }
}
