import { v } from "convex/values"
import {
    VENUE_APPS,
    APPS,
    SEVERITY_LEVELS,
    EVENT_TYPES,
} from "@valiq-trading/core"
import {
    ORDER_STATUSES,
    ORDER_ACTIONS,
    ORDER_TRANSITION_TYPES,
} from "@valiq-trading/core"

type LiteralValidator<T extends string> = ReturnType<typeof v.literal<T>>

function stringLiterals<const T extends readonly [string, ...string[]]>(values: T) {
    const validators = values.map((s) => v.literal(s))
    return v.union(
        ...(validators as [LiteralValidator<T[number]>, LiteralValidator<T[number]>, ...LiteralValidator<T[number]>[]])
    )
}

export const venueAppV = stringLiterals(VENUE_APPS)
export const appV = stringLiterals(APPS)
export const orderStatusV = stringLiterals(ORDER_STATUSES)
export const orderActionV = stringLiterals(ORDER_ACTIONS)
export const orderTransitionTypeV = stringLiterals(ORDER_TRANSITION_TYPES)
export const severityV = stringLiterals(SEVERITY_LEVELS)
export const eventTypeV = stringLiterals(EVENT_TYPES)

export const claimSourceV = v.union(
    v.literal("position"),
    v.literal("order"),
)
