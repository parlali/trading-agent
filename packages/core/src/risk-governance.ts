import type { StrategyRiskCooldownState, StrategySafetyState } from "./types"
import { readFiniteNumber, readTrimmedString } from "./value-readers"

export interface RiskGovernanceOrderRecord {
    action: string
    status: string
    instrument: string
    updatedAt: number
    filledQuantity: number
    avgFillPrice?: number
    intent?: unknown
}

export interface RiskGovernanceFaultRecord {
    instrument: string
    blocked?: boolean
    resolvedAt?: number
}

export interface RiskGovernancePolicy {
    maxDrawdownDay?: number
    maxDrawdownWeek?: number
    cooldownMinutesAfterDayBreach: number
    cooldownMinutesAfterWeekBreach: number
    strategyTimezone: string
}

export interface ExistingRiskGovernanceState {
    cooldownActive?: boolean
    cooldownReason?: StrategyRiskCooldownState["reason"] | string
    cooldownStartedAt?: number
    cooldownExpiresAt?: number
    lastBreachReason?: StrategyRiskCooldownState["reason"] | string
}

export interface RiskWindowStarts {
    dayStartAt: number
    weekStartAt: number
}

export interface RecentTradeDigest {
    dayEntries: number
    dayCloses: number
    dayForcedExits: number
    dayRejectedOrTerminal: number
    weekRealizedPnl: number
    closeOutStreakDirection?: "win" | "loss"
    closeOutStreakCount: number
}

export interface ComputedRiskGovernanceState {
    safetyState: StrategySafetyState
    dayRealizedPnl: number
    weekRealizedPnl: number
    dayDrawdownProgress?: number
    weekDrawdownProgress?: number
    dayBreached: boolean
    weekBreached: boolean
    cooldown: {
        active: boolean
        reason?: StrategyRiskCooldownState["reason"]
        startedAt?: number
        expiresAt?: number
        expired: boolean
        entered: boolean
        enteredReason?: StrategyRiskCooldownState["reason"]
    }
    blockedInstruments: string[]
    forcedExitClusterInstruments: string[]
    unresolvedExecutionFaultCount: number
    lastBreachReason?: StrategyRiskCooldownState["reason"]
    windows: RiskWindowStarts
}

function readBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean"
        ? value
        : undefined
}

function resolveSafeTimezone(value: string): string {
    const timezone = readTrimmedString(value) ?? "UTC"
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0))
        return timezone
    } catch {
        return "UTC"
    }
}

function isCooldownReason(value: string): value is NonNullable<StrategyRiskCooldownState["reason"]> {
    return value === "day_drawdown" ||
        value === "week_drawdown" ||
        value === "forced_exit_cluster" ||
        value === "execution_fault"
}

function normalizeCooldownReason(value: StrategyRiskCooldownState["reason"] | string | undefined): StrategyRiskCooldownState["reason"] {
    if (!value) {
        return undefined
    }

    return isCooldownReason(value) ? value : undefined
}

function resolveLocalNow(timestamp: number, timezone: string): Date {
    const value = new Date(timestamp).toLocaleString("en-US", { timeZone: resolveSafeTimezone(timezone) })
    return new Date(value)
}

function resolveOrderMetadata(order: RiskGovernanceOrderRecord): Record<string, unknown> | undefined {
    if (!order.intent || typeof order.intent !== "object") {
        return undefined
    }

    const intent = order.intent as Record<string, unknown>
    const nested = intent.metadata
    if (nested && typeof nested === "object") {
        return nested as Record<string, unknown>
    }

    return undefined
}

function resolveDrawdownProgress(realizedPnl: number, limit: number | undefined): number | undefined {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
        return undefined
    }

    if (realizedPnl >= 0) {
        return 0
    }

    return Math.abs(realizedPnl) / limit
}

export function resolveRiskWindowStarts(timestamp: number, timezone: string): RiskWindowStarts {
    const zonedNow = resolveLocalNow(timestamp, timezone)
    const zonedDayStart = new Date(zonedNow)
    zonedDayStart.setHours(0, 0, 0, 0)

    const zonedWeekStart = new Date(zonedDayStart)
    const localWeekday = zonedDayStart.getDay()
    const daysSinceMonday = (localWeekday + 6) % 7
    zonedWeekStart.setDate(zonedWeekStart.getDate() - daysSinceMonday)

    const dayDelta = zonedNow.getTime() - zonedDayStart.getTime()
    const weekDelta = zonedNow.getTime() - zonedWeekStart.getTime()

    return {
        dayStartAt: timestamp - dayDelta,
        weekStartAt: timestamp - weekDelta,
    }
}

export function resolveCloseOrderRealizedPnl(order: RiskGovernanceOrderRecord): number | undefined {
    if (order.action !== "close") {
        return undefined
    }

    if (order.status !== "filled" && order.status !== "partially_filled") {
        return undefined
    }

    const metadata = resolveOrderMetadata(order)
    const entryPrice = readFiniteNumber(metadata?.entryPrice)
    const closePrice = order.avgFillPrice

    if (entryPrice === undefined || closePrice === undefined || order.filledQuantity <= 0) {
        return undefined
    }

    const side = readTrimmedString(metadata?.positionSide) === "short"
        ? "short"
        : "long"

    if (side === "short") {
        return (entryPrice - closePrice) * order.filledQuantity
    }

    return (closePrice - entryPrice) * order.filledQuantity
}

export function computeRecentTradeDigest(args: {
    orders: RiskGovernanceOrderRecord[]
    timezone: string
    timestamp: number
}): RecentTradeDigest {
    const windows = resolveRiskWindowStarts(args.timestamp, args.timezone)
    const dayOrders = args.orders.filter((order) => order.updatedAt >= windows.dayStartAt)
    const weekOrders = args.orders.filter((order) => order.updatedAt >= windows.weekStartAt)

    const dayEntries = dayOrders.filter((order) => order.action === "entry").length
    const dayCloses = dayOrders.filter((order) => order.action === "close").length
    const dayForcedExits = dayOrders.filter((order) => {
        if (order.action !== "close") {
            return false
        }
        const metadata = resolveOrderMetadata(order)
        return metadata?.forcedExit === true
    }).length
    const dayRejectedOrTerminal = dayOrders.filter((order) =>
        order.status === "rejected" ||
        order.status === "cancelled" ||
        order.status === "expired" ||
        order.status === "timed_out"
    ).length

    const weekRealizedPnl = weekOrders.reduce((sum, order) => {
        const realized = resolveCloseOrderRealizedPnl(order)
        return realized !== undefined ? sum + realized : sum
    }, 0)

    const closesByRecency = args.orders
        .filter((order) => order.action === "close")
        .sort((left, right) => right.updatedAt - left.updatedAt)

    let closeOutStreakDirection: "win" | "loss" | undefined
    let closeOutStreakCount = 0

    for (const order of closesByRecency) {
        const realized = resolveCloseOrderRealizedPnl(order)
        if (realized === undefined || realized === 0) {
            continue
        }

        const direction = realized > 0 ? "win" : "loss"
        if (!closeOutStreakDirection) {
            closeOutStreakDirection = direction
            closeOutStreakCount = 1
            continue
        }

        if (direction !== closeOutStreakDirection) {
            break
        }

        closeOutStreakCount++
    }

    return {
        dayEntries,
        dayCloses,
        dayForcedExits,
        dayRejectedOrTerminal,
        weekRealizedPnl,
        closeOutStreakDirection,
        closeOutStreakCount,
    }
}

export function computeRiskGovernanceState(args: {
    now: number
    orders: RiskGovernanceOrderRecord[]
    faults: RiskGovernanceFaultRecord[]
    policy: RiskGovernancePolicy
    existing?: ExistingRiskGovernanceState
}): ComputedRiskGovernanceState {
    const windows = resolveRiskWindowStarts(args.now, args.policy.strategyTimezone)
    const closeOrders = args.orders.filter((order) =>
        order.action === "close" && (order.status === "filled" || order.status === "partially_filled")
    )

    let dayRealizedPnl = 0
    let weekRealizedPnl = 0
    const forcedExitCountByInstrument = new Map<string, number>()

    for (const order of closeOrders) {
        const realized = resolveCloseOrderRealizedPnl(order)
        if (realized === undefined) {
            continue
        }

        if (order.updatedAt >= windows.weekStartAt) {
            weekRealizedPnl += realized
        }

        if (order.updatedAt >= windows.dayStartAt) {
            dayRealizedPnl += realized
        }

        const metadata = resolveOrderMetadata(order)
        const forcedExit = readBoolean(metadata?.forcedExit) === true
        if (forcedExit && order.updatedAt >= windows.dayStartAt) {
            const current = forcedExitCountByInstrument.get(order.instrument) ?? 0
            forcedExitCountByInstrument.set(order.instrument, current + 1)
        }
    }

    const forcedExitClusterInstruments = Array.from(forcedExitCountByInstrument.entries())
        .filter(([, count]) => count >= 2)
        .map(([instrument]) => instrument)
        .sort((left, right) => left.localeCompare(right))

    const unresolvedFaults = args.faults.filter((fault) => fault.resolvedAt === undefined)
    const blockedByFaults = unresolvedFaults
        .filter((fault) => fault.blocked === true)
        .map((fault) => fault.instrument)

    const blockedInstruments = Array.from(new Set([
        ...blockedByFaults,
        ...forcedExitClusterInstruments,
    ])).sort((left, right) => left.localeCompare(right))

    let cooldownActive = args.existing?.cooldownActive ?? false
    let cooldownReason = normalizeCooldownReason(args.existing?.cooldownReason)
    let cooldownStartedAt = args.existing?.cooldownStartedAt
    let cooldownExpiresAt = args.existing?.cooldownExpiresAt
    let lastBreachReason = normalizeCooldownReason(args.existing?.lastBreachReason)
    let cooldownExpired = false
    let cooldownEntered = false
    let cooldownEnteredReason: StrategyRiskCooldownState["reason"] | undefined

    if (cooldownActive && cooldownExpiresAt !== undefined && args.now >= cooldownExpiresAt) {
        cooldownActive = false
        cooldownReason = undefined
        cooldownStartedAt = undefined
        cooldownExpiresAt = undefined
        cooldownExpired = true
    }

    const weekBreached = args.policy.maxDrawdownWeek !== undefined
        ? weekRealizedPnl <= -Math.abs(args.policy.maxDrawdownWeek)
        : false
    const dayBreached = args.policy.maxDrawdownDay !== undefined
        ? dayRealizedPnl <= -Math.abs(args.policy.maxDrawdownDay)
        : false

    const enterCooldown = (
        reason: StrategyRiskCooldownState["reason"],
        cooldownMinutes: number
    ): void => {
        cooldownActive = true
        cooldownReason = reason
        cooldownStartedAt = args.now
        cooldownExpiresAt = args.now + cooldownMinutes * 60_000
        lastBreachReason = reason
        cooldownEntered = true
        cooldownEnteredReason = reason
    }

    if (!cooldownActive && (weekBreached || dayBreached)) {
        enterCooldown(
            weekBreached ? "week_drawdown" : "day_drawdown",
            weekBreached
                ? args.policy.cooldownMinutesAfterWeekBreach
                : args.policy.cooldownMinutesAfterDayBreach
        )
    }

    if (!cooldownActive && forcedExitClusterInstruments.length > 0) {
        enterCooldown("forced_exit_cluster", args.policy.cooldownMinutesAfterDayBreach)
    }

    const unresolvedExecutionFaultCount = unresolvedFaults.length
    const hasStrategyWideBlock = unresolvedFaults.some((fault) => fault.blocked === true && fault.instrument === "*")
    const safetyState: StrategySafetyState = hasStrategyWideBlock
        ? "blocked"
        : cooldownActive
            ? "cooldown"
            : unresolvedExecutionFaultCount > 0
                ? "execution_degraded"
                : "healthy"

    return {
        safetyState,
        dayRealizedPnl,
        weekRealizedPnl,
        dayDrawdownProgress: resolveDrawdownProgress(dayRealizedPnl, args.policy.maxDrawdownDay),
        weekDrawdownProgress: resolveDrawdownProgress(weekRealizedPnl, args.policy.maxDrawdownWeek),
        dayBreached,
        weekBreached,
        cooldown: {
            active: cooldownActive,
            reason: cooldownReason,
            startedAt: cooldownStartedAt,
            expiresAt: cooldownExpiresAt,
            expired: cooldownExpired,
            entered: cooldownEntered,
            enteredReason: cooldownEnteredReason,
        },
        blockedInstruments,
        forcedExitClusterInstruments,
        unresolvedExecutionFaultCount,
        lastBreachReason,
        windows,
    }
}
