import type { AccountState, Position } from "./types"

export interface StrategyAccountAllocation {
    allocationPercent: number
}

export interface ResolveStrategyAccountStateArgs {
    providerAccountState: AccountState
    positions: Position[]
    policy: Record<string, unknown>
    realizedPnl?: number
}

export function readStrategyAccountAllocation(policy: Record<string, unknown>): StrategyAccountAllocation | undefined {
    const safety = readRecord(policy.safety)
    const account = readRecord(safety?.account)
    const allocationPercent = readAllocationPercent(account?.allocationPercent)

    if (allocationPercent === undefined) {
        return undefined
    }

    return {
        allocationPercent,
    }
}

export function resolveStrategyAccountState(args: ResolveStrategyAccountStateArgs): AccountState {
    const allocation = readStrategyAccountAllocation(args.policy)

    if (!allocation) {
        throw new Error("Strategy account allocation is required at policy.safety.account.allocationPercent")
    }

    const allocationRatio = allocation.allocationPercent / 100
    const strategyOpenPnl = sumFinite(args.positions.map((position) => position.unrealizedPnl))
    const strategyRealizedPnl = typeof args.realizedPnl === "number" && Number.isFinite(args.realizedPnl)
        ? args.realizedPnl
        : 0
    const strategyMarginUsed = sumFinite(args.positions.map(resolvePositionMarginUsage))
    const strategyBalance = Math.max(args.providerAccountState.balance, 0) * allocationRatio
    const strategyEquity = strategyBalance + strategyOpenPnl
    const availableByBudget = Math.max(strategyEquity - strategyMarginUsed, 0)
    const providerAvailable = Math.min(
        Math.max(args.providerAccountState.buyingPower, 0),
        Math.max(args.providerAccountState.marginAvailable, 0)
    ) * allocationRatio
    const buyingPower = Math.min(availableByBudget, providerAvailable)

    return {
        balance: strategyBalance,
        equity: strategyEquity,
        buyingPower,
        marginUsed: strategyMarginUsed,
        marginAvailable: buyingPower,
        openPnl: strategyOpenPnl,
        dayPnl: strategyRealizedPnl + strategyOpenPnl,
    }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object"
        ? value as Record<string, unknown>
        : undefined
}

function readNonNegativeNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined
}

function readAllocationPercent(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
        ? value
        : undefined
}

function sumFinite(values: Array<number | undefined>): number {
    return values.reduce<number>((sum, value) =>
        typeof value === "number" && Number.isFinite(value) ? sum + value : sum, 0)
}

function resolvePositionMarginUsage(position: Position): number {
    const metadataMargin = readNonNegativeNumber(position.metadata?.marginUsed)

    if (metadataMargin !== undefined) {
        return metadataMargin
    }

    return Math.abs(position.quantity * position.entryPrice)
}
