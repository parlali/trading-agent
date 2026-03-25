/**
 * MT5-specific risk validators.
 *
 * These are layered on top of the base risk validators (balance floor,
 * max loss per trade, max total exposure, duplicate prevention) from
 * packages/core.
 */

import {
    mt5PolicySchema,
    type AccountState,
    type MT5Policy,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export const mt5RiskValidators: readonly RiskValidator[] = [
    maxDailyLossValidator,
    maxConcurrentPositionsValidator,
    allowedInstrumentsValidator,
    tradingHoursValidator,
    leverageValidator,
    emergencyFlattenValidator,
]

// ---------------------------------------------------------------------------
// Max daily loss -- hard stop: if cumulative daily realized + unrealized loss
// exceeds the threshold, block all new entries for the day.
// ---------------------------------------------------------------------------

function maxDailyLossValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState,
    _positions: Position[]
) {
    // Allow close actions even if daily loss is exceeded
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)

    // dayPnl tracks the realized+unrealized P&L for the current day
    // A negative dayPnl means we're in a loss
    if (state.dayPnl < 0 && Math.abs(state.dayPnl) >= policy.maxDailyLoss) {
        return {
            allowed: false,
            reason: `Daily loss ${Math.abs(state.dayPnl).toFixed(2)} has reached max daily loss limit ${policy.maxDailyLoss}. No new entries allowed.`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Max concurrent positions
// ---------------------------------------------------------------------------

function maxConcurrentPositionsValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)

    if (positions.length >= policy.maxConcurrentPositions) {
        return {
            allowed: false,
            reason: `Already at max concurrent positions (${positions.length}/${policy.maxConcurrentPositions})`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Instrument whitelist
// ---------------------------------------------------------------------------

function allowedInstrumentsValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    const policy = mt5PolicySchema.parse(rawPolicy)
    const instrument = intent.instrument.toUpperCase()
    const allowed = policy.allowedInstruments.map((s) => s.toUpperCase())

    if (!allowed.includes(instrument)) {
        return {
            allowed: false,
            reason: `Instrument ${intent.instrument} is not in the allowed instruments list: [${policy.allowedInstruments.join(", ")}]`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Trading hours enforcement -- reject orders outside allowed window.
// The strategy context describes when the agent should think about trading;
// this validator is the hard gate.
// ---------------------------------------------------------------------------

function tradingHoursValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    if (isCloseAction(intent)) {
        // Always allow closing -- especially for end-of-day flatten
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)
    const { start, end, timezone } = policy.tradingHours

    const now = getCurrentTimeInTimezone(timezone)
    const [startHour, startMinute] = start.split(":").map(Number) as [number, number]
    const [endHour, endMinute] = end.split(":").map(Number) as [number, number]

    const currentMinutes = now.hours * 60 + now.minutes
    const startMinutes = startHour * 60 + startMinute
    const endMinutes = endHour * 60 + endMinute

    // Handle overnight windows (e.g., 22:00 to 06:00) and standard windows
    let withinWindow: boolean

    if (startMinutes <= endMinutes) {
        // Standard window: e.g., 09:00 to 17:00
        withinWindow = currentMinutes >= startMinutes && currentMinutes < endMinutes
    } else {
        // Overnight window: e.g., 22:00 to 06:00
        withinWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes
    }

    if (!withinWindow) {
        return {
            allowed: false,
            reason: `Outside trading hours. Current time: ${padTime(now.hours)}:${padTime(now.minutes)} ${timezone}. Allowed: ${start}-${end}`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Leverage check -- ensure the proposed position doesn't exceed max leverage.
// Estimated as (position value / equity).
// ---------------------------------------------------------------------------

function leverageValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)
    const price = intent.limitPrice ?? intent.stopPrice ?? 0

    if (price <= 0 || state.balance <= 0) {
        // Can't calculate leverage without price info -- allow and rely on broker limits
        return { allowed: true }
    }

    // Rough leverage estimate: (notional value of new position) / equity
    const notionalValue = intent.quantity * price
    const currentMarginUsed = state.marginUsed
    const totalExposure = currentMarginUsed + notionalValue
    const effectiveLeverage = totalExposure / state.balance

    if (effectiveLeverage > policy.maxLeverage) {
        return {
            allowed: false,
            reason: `Effective leverage would be ${effectiveLeverage.toFixed(1)}x, exceeding max ${policy.maxLeverage}x`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Emergency flatten threshold -- if unrealized loss exceeds this, the agent
// should NOT be opening new positions. The actual flatten is triggered by the
// orchestrator, not this validator. This validator just blocks new entries.
// ---------------------------------------------------------------------------

function emergencyFlattenValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState
) {
    if (isCloseAction(intent)) {
        return { allowed: true }
    }

    const policy = mt5PolicySchema.parse(rawPolicy)

    if (state.openPnl < 0 && Math.abs(state.openPnl) >= policy.emergencyFlattenThreshold) {
        return {
            allowed: false,
            reason: `Unrealized loss ${Math.abs(state.openPnl).toFixed(2)} exceeds emergency flatten threshold ${policy.emergencyFlattenThreshold}. Close positions first.`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCloseAction(intent: OrderIntent): boolean {
    const action = intent.metadata?.action
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order"
}

function getCurrentTimeInTimezone(timezone: string): { hours: number; minutes: number } {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        })
        const parts = formatter.formatToParts(new Date())
        const hourPart = parts.find((p) => p.type === "hour")
        const minutePart = parts.find((p) => p.type === "minute")

        return {
            hours: Number(hourPart?.value ?? 0),
            minutes: Number(minutePart?.value ?? 0),
        }
    } catch {
        // Fallback to UTC
        const now = new Date()
        return { hours: now.getUTCHours(), minutes: now.getUTCMinutes() }
    }
}

function padTime(n: number): string {
    return String(n).padStart(2, "0")
}
