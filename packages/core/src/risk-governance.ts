import type { StrategyRiskCooldownState, StrategySafetyState } from "./types"
import { resolveOptionContractMultiplier } from "./option-multiplier"
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

interface RealizedPnlByWindow {
    dayRealizedPnl: number
    weekRealizedPnl: number
}

interface DrawdownBreachState {
    dayBreached: boolean
    weekBreached: boolean
}

interface FaultExposureState {
    blockedInstruments: string[]
    unresolvedExecutionFaultCount: number
    hasStrategyWideBlock: boolean
}

interface ComputedCooldownState {
    active: boolean
    reason?: StrategyRiskCooldownState["reason"]
    startedAt?: number
    expiresAt?: number
    expired: boolean
    entered: boolean
    enteredReason?: StrategyRiskCooldownState["reason"]
    lastBreachReason?: StrategyRiskCooldownState["reason"]
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

function isFilledOrder(order: RiskGovernanceOrderRecord): boolean {
    return order.status === "filled" || order.status === "partially_filled"
}

function isFilledCloseOrder(order: RiskGovernanceOrderRecord): boolean {
    return order.action === "close" && isFilledOrder(order)
}

function isRejectedOrTerminalOrder(order: RiskGovernanceOrderRecord): boolean {
    return order.status === "rejected" ||
        order.status === "cancelled" ||
        order.status === "expired" ||
        order.status === "timed_out"
}

function isForcedExitOrder(order: RiskGovernanceOrderRecord): boolean {
    return readBoolean(resolveOrderMetadata(order)?.forcedExit) === true
}

function resolveRealizedPnlByWindow(
    orders: RiskGovernanceOrderRecord[],
    windows: RiskWindowStarts
): RealizedPnlByWindow {
    let dayRealizedPnl = 0
    let weekRealizedPnl = 0

    for (const order of orders) {
        if (!isFilledOrder(order)) {
            continue
        }

        const realized = resolveOrderRealizedPnl(order)
        if (realized === undefined) {
            continue
        }

        if (order.updatedAt >= windows.weekStartAt) {
            weekRealizedPnl += realized
        }

        if (order.updatedAt >= windows.dayStartAt) {
            dayRealizedPnl += realized
        }
    }

    return {
        dayRealizedPnl,
        weekRealizedPnl,
    }
}

function resolveForcedExitClusterInstruments(
    orders: RiskGovernanceOrderRecord[],
    dayStartAt: number
): string[] {
    const forcedExitCountByInstrument = new Map<string, number>()

    for (const order of orders) {
        if (!isFilledCloseOrder(order) || order.updatedAt < dayStartAt || !isForcedExitOrder(order)) {
            continue
        }

        const current = forcedExitCountByInstrument.get(order.instrument) ?? 0
        forcedExitCountByInstrument.set(order.instrument, current + 1)
    }

    return Array.from(forcedExitCountByInstrument.entries())
        .filter(([, count]) => count >= 2)
        .map(([instrument]) => instrument)
        .sort((left, right) => left.localeCompare(right))
}

function resolveFaultExposureState(
    faults: RiskGovernanceFaultRecord[],
    forcedExitClusterInstruments: string[]
): FaultExposureState {
    const unresolvedFaults = faults.filter((fault) => fault.resolvedAt === undefined)
    const blockedByFaults = unresolvedFaults
        .filter((fault) => fault.blocked === true)
        .map((fault) => fault.instrument)

    return {
        blockedInstruments: Array.from(new Set([
            ...blockedByFaults,
            ...forcedExitClusterInstruments,
        ])).sort((left, right) => left.localeCompare(right)),
        unresolvedExecutionFaultCount: unresolvedFaults.length,
        hasStrategyWideBlock: unresolvedFaults.some((fault) => fault.blocked === true && fault.instrument === "*"),
    }
}

function resolveDrawdownBreaches(
    realizedPnl: RealizedPnlByWindow,
    policy: RiskGovernancePolicy
): DrawdownBreachState {
    return {
        weekBreached: policy.maxDrawdownWeek !== undefined
            ? realizedPnl.weekRealizedPnl <= -Math.abs(policy.maxDrawdownWeek)
            : false,
        dayBreached: policy.maxDrawdownDay !== undefined
            ? realizedPnl.dayRealizedPnl <= -Math.abs(policy.maxDrawdownDay)
            : false,
    }
}

function resolveCooldownState(args: {
    now: number
    policy: RiskGovernancePolicy
    existing?: ExistingRiskGovernanceState
    breaches: DrawdownBreachState
    forcedExitClusterInstruments: string[]
}): ComputedCooldownState {
    let active = args.existing?.cooldownActive ?? false
    let reason = normalizeCooldownReason(args.existing?.cooldownReason)
    let startedAt = args.existing?.cooldownStartedAt
    let expiresAt = args.existing?.cooldownExpiresAt
    let lastBreachReason = normalizeCooldownReason(args.existing?.lastBreachReason)
    let expired = false
    let entered = false
    let enteredReason: StrategyRiskCooldownState["reason"] | undefined

    const expireCooldown = (): void => {
        active = false
        reason = undefined
        startedAt = undefined
        expiresAt = undefined
        expired = true
    }

    const enterCooldown = (
        nextReason: StrategyRiskCooldownState["reason"],
        cooldownMinutes: number
    ): void => {
        active = true
        reason = nextReason
        startedAt = args.now
        expiresAt = args.now + cooldownMinutes * 60_000
        lastBreachReason = nextReason
        entered = true
        enteredReason = nextReason
    }

    if (active && expiresAt !== undefined && args.now >= expiresAt) {
        expireCooldown()
    }

    if (!active && (args.breaches.weekBreached || args.breaches.dayBreached)) {
        enterCooldown(
            args.breaches.weekBreached ? "week_drawdown" : "day_drawdown",
            args.breaches.weekBreached
                ? args.policy.cooldownMinutesAfterWeekBreach
                : args.policy.cooldownMinutesAfterDayBreach
        )
    }

    if (!active && args.forcedExitClusterInstruments.length > 0) {
        enterCooldown("forced_exit_cluster", args.policy.cooldownMinutesAfterDayBreach)
    }

    return {
        active,
        reason,
        startedAt,
        expiresAt,
        expired,
        entered,
        enteredReason,
        lastBreachReason,
    }
}

function resolveSafetyState(args: {
    hasStrategyWideBlock: boolean
    cooldownActive: boolean
    unresolvedExecutionFaultCount: number
}): StrategySafetyState {
    if (args.hasStrategyWideBlock) {
        return "blocked"
    }

    if (args.cooldownActive) {
        return "cooldown"
    }

    if (args.unresolvedExecutionFaultCount > 0) {
        return "execution_degraded"
    }

    return "healthy"
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
    const providerRealizedPnl = resolveProviderReportedRealizedPnl(metadata, false)
    if (providerRealizedPnl !== undefined) {
        return providerRealizedPnl
    }

    if (requiresProviderReportedClosePnl(metadata)) {
        return undefined
    }

    const entryPrice = readFiniteNumber(metadata?.entryPrice)
    const closePrice = order.avgFillPrice

    if (entryPrice === undefined || closePrice === undefined || order.filledQuantity <= 0) {
        return undefined
    }

    const side = readTrimmedString(metadata?.positionSide) === "short"
        ? "short"
        : "long"

    if (side === "short") {
        return (entryPrice - closePrice) * order.filledQuantity * resolveOrderNotionalMultiplier(order.instrument, metadata)
    }

    return (closePrice - entryPrice) * order.filledQuantity * resolveOrderNotionalMultiplier(order.instrument, metadata)
}

function resolveOrderNotionalMultiplier(
    instrument: string,
    metadata: Record<string, unknown> | undefined
): number {
    return resolveOptionContractMultiplier(instrument, metadata)
}

function requiresProviderReportedClosePnl(
    metadata: Record<string, unknown> | undefined
): boolean {
    return readTrimmedString(metadata?.posId) !== undefined ||
        readTrimmedString(metadata?.positionMode) !== undefined
}

export function resolveOrderRealizedPnl(order: RiskGovernanceOrderRecord): number | undefined {
    if (order.status !== "filled" && order.status !== "partially_filled") {
        return undefined
    }

    if (order.action === "close") {
        return resolveCloseOrderRealizedPnl(order)
    }

    return resolveProviderReportedRealizedPnl(resolveOrderMetadata(order), true)
}

function resolveProviderReportedRealizedPnl(
    metadata: Record<string, unknown> | undefined,
    allowFeeOnly: boolean
): number | undefined {
    const fillPnl = readFiniteNumber(metadata?.fillPnl)
    const fee = resolveSettlementCurrencyFee(metadata)
    const swap = readFiniteNumber(metadata?.swap)
    const commission = readFiniteNumber(metadata?.commission)

    if (fillPnl !== undefined) {
        return fillPnl + (fee ?? 0) + (swap ?? 0) + (commission ?? 0)
    }

    if (!allowFeeOnly) {
        return undefined
    }

    return fee
}

function resolveSettlementCurrencyFee(
    metadata: Record<string, unknown> | undefined
): number | undefined {
    const fee = readFiniteNumber(metadata?.fee)
    if (fee === undefined) {
        return undefined
    }

    const feeCurrency = readTrimmedString(metadata?.feeCcy)?.toUpperCase()
    if (feeCurrency && !isSettlementCurrency(feeCurrency)) {
        const source = readTrimmedString(metadata?.providerAccountingSource) ?? "provider_metadata"
        throw new Error(`Non-settlement fee currency ${feeCurrency} from ${source} cannot be included in realized PnL`)
    }

    return fee
}

export const SETTLEMENT_CURRENCIES = ["USD", "USDT", "USDC"] as const

export function isSettlementCurrency(currency: string): boolean {
    return SETTLEMENT_CURRENCIES.includes(currency.toUpperCase() as typeof SETTLEMENT_CURRENCIES[number])
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
    const dayForcedExits = dayOrders.filter((order) => order.action === "close" && isForcedExitOrder(order)).length
    const dayRejectedOrTerminal = dayOrders.filter(isRejectedOrTerminalOrder).length

    const weekRealizedPnl = weekOrders.reduce((sum, order) => {
        const realized = resolveOrderRealizedPnl(order)
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
    const realizedPnl = resolveRealizedPnlByWindow(args.orders, windows)
    const breaches = resolveDrawdownBreaches(realizedPnl, args.policy)
    const forcedExitClusterInstruments = resolveForcedExitClusterInstruments(args.orders, windows.dayStartAt)
    const faultExposure = resolveFaultExposureState(args.faults, forcedExitClusterInstruments)
    const cooldown = resolveCooldownState({
        now: args.now,
        policy: args.policy,
        existing: args.existing,
        breaches,
        forcedExitClusterInstruments,
    })
    const safetyState = resolveSafetyState({
        hasStrategyWideBlock: faultExposure.hasStrategyWideBlock,
        cooldownActive: cooldown.active,
        unresolvedExecutionFaultCount: faultExposure.unresolvedExecutionFaultCount,
    })

    return {
        safetyState,
        dayRealizedPnl: realizedPnl.dayRealizedPnl,
        weekRealizedPnl: realizedPnl.weekRealizedPnl,
        dayDrawdownProgress: resolveDrawdownProgress(realizedPnl.dayRealizedPnl, args.policy.maxDrawdownDay),
        weekDrawdownProgress: resolveDrawdownProgress(realizedPnl.weekRealizedPnl, args.policy.maxDrawdownWeek),
        dayBreached: breaches.dayBreached,
        weekBreached: breaches.weekBreached,
        cooldown: {
            active: cooldown.active,
            reason: cooldown.reason,
            startedAt: cooldown.startedAt,
            expiresAt: cooldown.expiresAt,
            expired: cooldown.expired,
            entered: cooldown.entered,
            enteredReason: cooldown.enteredReason,
        },
        blockedInstruments: faultExposure.blockedInstruments,
        forcedExitClusterInstruments,
        unresolvedExecutionFaultCount: faultExposure.unresolvedExecutionFaultCount,
        lastBreachReason: cooldown.lastBreachReason,
        windows,
    }
}
