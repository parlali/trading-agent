import { getCurrentTimeInTimezone, padTime } from "./runtime-time"
import type {
    OrderIntent,
    AccountState,
    GateEvaluation,
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

export type GateComparison = "min" | "max"

export function rejectRisk(reason: string): { allowed: false; reason: string } {
    return { allowed: false, reason }
}

export function createGateEvaluation(args: {
    gateKey: string
    observed: number
    threshold: number
    comparison: GateComparison
    scale?: number
    tolerance?: number
}): GateEvaluation {
    const distance = args.comparison === "min"
        ? args.observed - args.threshold + (args.tolerance ?? 0)
        : args.threshold - args.observed + (args.tolerance ?? 0)

    return {
        gateKey: args.gateKey,
        observed: args.observed,
        threshold: args.threshold,
        margin: distance / resolveGateScale(args.threshold, args.scale),
    }
}

export function createWindowGateEvaluation(args: {
    gateKey: string
    observed: number
    start: number
    end: number
    withinWindow: boolean
    scale?: number
}): GateEvaluation {
    const scale = resolveGateScale(1, args.scale)
    const candidates = resolveWindowBoundaryDistances(args.observed, args.start, args.end, args.withinWindow)
    const nearest = candidates.reduce((best, candidate) =>
        Math.abs(candidate.distance) < Math.abs(best.distance) ? candidate : best
    )

    return {
        gateKey: args.gateKey,
        observed: args.observed,
        threshold: nearest.threshold,
        margin: nearest.distance / scale,
    }
}

export function allowWithGateEvaluation(gateEvaluation: GateEvaluation): ValidationResult {
    return allowWithGateEvaluations([gateEvaluation])
}

export function allowWithGateEvaluations(gateEvaluations: readonly GateEvaluation[]): ValidationResult {
    return gateEvaluations.length === 0
        ? ALLOWED_VALIDATION_RESULT
        : {
            allowed: true,
            gateEvaluations: [...gateEvaluations],
        }
}

export function rejectRiskWithGateEvaluation(
    reason: string,
    gateEvaluation: GateEvaluation
): ValidationResult {
    return rejectRiskWithGateEvaluations(reason, [gateEvaluation])
}

export function rejectRiskWithGateEvaluations(
    reason: string,
    gateEvaluations: readonly GateEvaluation[]
): ValidationResult {
    return {
        allowed: false,
        reason,
        gateEvaluations: [...gateEvaluations],
    }
}

export function resolveStopDistanceSpreadMultiple(stopDistance: number, absoluteSpread: number): number {
    if (absoluteSpread > 0) {
        return stopDistance / absoluteSpread
    }

    return stopDistance > 0 ? Number.MAX_SAFE_INTEGER : 0
}

function resolveGateScale(threshold: number, scale?: number): number {
    const candidate = scale ?? Math.abs(threshold)
    return Number.isFinite(candidate) && candidate > 0
        ? candidate
        : 1
}

function resolveWindowBoundaryDistances(
    observed: number,
    start: number,
    end: number,
    withinWindow: boolean
): Array<{ threshold: number; distance: number }> {
    if (start <= end) {
        if (withinWindow) {
            return [
                { threshold: start, distance: observed - start },
                { threshold: end, distance: end - observed },
            ]
        }

        return observed < start
            ? [{ threshold: start, distance: observed - start }]
            : [{ threshold: end, distance: end - observed }]
    }

    if (withinWindow) {
        return observed >= start
            ? [
                { threshold: start, distance: observed - start },
                { threshold: end, distance: 1_440 - observed + end },
            ]
            : [
                { threshold: end, distance: end - observed },
                { threshold: start, distance: observed + 1_440 - start },
            ]
    }

    return [
        { threshold: end, distance: end - observed },
        { threshold: start, distance: observed - start },
    ]
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

    const duplicate = getIntentAction(intent) === "adjustment"
        ? undefined
        : positions.find(
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
    gateKey?: string
}): ValidationResult {
    const windowState = resolveTradingHoursWindowState(args)
    const gateEvaluation = createWindowGateEvaluation({
        gateKey: args.gateKey ?? "core.tradingHours",
        observed: windowState.currentMinutes,
        start: windowState.startMinutes,
        end: windowState.endMinutes,
        withinWindow: windowState.withinWindow,
        scale: 1_440,
    })

    if (!windowState.withinWindow) {
        return rejectRiskWithGateEvaluation(
            `Outside trading hours. Current time: ${windowState.currentTime} ${args.timezone}. Allowed: ${args.start}-${args.end}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

export function resolveTradingHoursWindowState(args: {
    start: string
    end: string
    timezone: string
}): {
    currentTime: string
    currentMinutes: number
    startMinutes: number
    endMinutes: number
    withinWindow: boolean
    minutesUntilEnd: number
} {
    const now = getCurrentTimeInTimezone(args.timezone)
    const startMinutes = parseTradingHoursMinutes(args.start)
    const endMinutes = parseTradingHoursMinutes(args.end)
    const currentMinutes = now.hours * 60 + now.minutes
    const withinWindow = startMinutes <= endMinutes
        ? currentMinutes >= startMinutes && currentMinutes < endMinutes
        : currentMinutes >= startMinutes || currentMinutes < endMinutes
    const minutesPerDay = 1_440

    return {
        currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
        currentMinutes,
        startMinutes,
        endMinutes,
        withinWindow,
        minutesUntilEnd: ((endMinutes - currentMinutes) % minutesPerDay + minutesPerDay) % minutesPerDay,
    }
}

function parseTradingHoursMinutes(value: string): number {
    const [hour, minute] = value.split(":").map(Number) as [number, number]
    return hour * 60 + minute
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
    const gateEvaluations: GateEvaluation[] = []

    for (const validator of validators) {
        const result = validator(currentIntent, policy, state, positions)
        if (result.gateEvaluations) {
            gateEvaluations.push(...result.gateEvaluations)
        }

        if (!result.allowed) {
            return gateEvaluations.length === 0
                ? result
                : {
                    ...result,
                    gateEvaluations,
                }
        }

        if (result.adjustedIntent) {
            currentIntent = result.adjustedIntent
        }
    }

    if (gateEvaluations.length > 0) {
        return currentIntent === intent
            ? {
                allowed: true,
                gateEvaluations,
            }
            : {
                allowed: true,
                adjustedIntent: currentIntent,
                gateEvaluations,
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
