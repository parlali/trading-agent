import type { AccountState, ExecutionResult, Position } from "./types"

export const DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT = "__DRY_RUN_ACCOUNT_LEDGER__"

export function isDryRunAccountLedgerPosition(position: Pick<Position, "instrument">): boolean {
    return position.instrument === DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT
}

export function resolveDryRunAccountState(args: {
    policy: Record<string, unknown>
    positions: Position[]
}): AccountState {
    let dryRunCashAdjustment = 0
    let dryRunRealizedPnl = 0
    const ledger = args.positions.find((position) => isDryRunAccountLedgerPosition(position))

    if (ledger) {
        dryRunCashAdjustment = readNumber(ledger.metadata?.cashAdjustment) ?? 0
        dryRunRealizedPnl = readNumber(ledger.metadata?.realizedPnl) ?? 0
    }

    for (const position of args.positions) {
        if (isDryRunAccountLedgerPosition(position)) {
            continue
        }

        if (!ledger) {
            dryRunCashAdjustment += resolveDryRunOpeningCashDelta(position)
        }
    }

    return buildDryRunAccountState({
        policy: args.policy,
        positions: args.positions.filter((position) => !isDryRunAccountLedgerPosition(position)),
        cashAdjustment: dryRunCashAdjustment,
        realizedPnl: dryRunRealizedPnl,
    })
}

export function buildDryRunAccountState(args: {
    policy: Record<string, unknown>
    positions: Position[]
    cashAdjustment: number
    realizedPnl: number
}): AccountState {
    const initialCash = typeof args.policy.dryRunInitialCash === "number"
        ? args.policy.dryRunInitialCash
        : typeof args.policy.virtualCash === "number"
            ? args.policy.virtualCash
            : 1000
    let currentValue = 0
    let marginUsed = 0
    let openPnl = 0

    for (const position of args.positions) {
        const mark = position.currentPrice ?? position.entryPrice
        const marketValue = position.quantity * mark
        currentValue += position.side === "short" ? -marketValue : marketValue
        marginUsed += Math.abs(marketValue)
        openPnl += position.unrealizedPnl ?? resolveDryRunUnrealizedPnl(
            position.side,
            position.quantity,
            position.entryPrice,
            mark
        ) ?? 0
    }

    const balance = initialCash + args.cashAdjustment
    const equity = balance + currentValue
    const dayPnl = args.realizedPnl + openPnl

    return {
        balance,
        equity,
        buyingPower: Math.max(balance, 0),
        marginUsed,
        marginAvailable: Math.max(balance, 0),
        openPnl,
        dayPnl,
    }
}

export function createDryRunAccountLedgerPosition(args: {
    policy: Record<string, unknown>
    positions: Position[]
    cashAdjustment: number
    realizedPnl: number
    runId: string
}): Position {
    const state = buildDryRunAccountState({
        policy: args.policy,
        positions: args.positions,
        cashAdjustment: args.cashAdjustment,
        realizedPnl: args.realizedPnl,
    })

    return {
        instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
        side: "long",
        quantity: 0,
        entryPrice: 0,
        currentPrice: 0,
        unrealizedPnl: 0,
        metadata: {
            dryRunLedger: true,
            cashAdjustment: args.cashAdjustment,
            realizedPnl: args.realizedPnl,
            balance: state.balance,
            equity: state.equity,
            openPnl: state.openPnl,
            dayPnl: state.dayPnl,
            sourceRunId: args.runId,
        },
    }
}

export function resolveDryRunCurrentPrice(
    metadata?: Record<string, unknown>,
    result?: ExecutionResult
): number | undefined {
    if (typeof result?.priceVerification?.livePrices.mid === "number") {
        return result.priceVerification.livePrices.mid
    }

    if (typeof metadata?.currentPrice === "number") {
        return metadata.currentPrice
    }

    if (typeof metadata?.estimatedPrice === "number") {
        return metadata.estimatedPrice
    }

    return undefined
}

export function resolveDryRunUnrealizedPnl(
    side: Position["side"],
    quantity: number,
    entryPrice: number,
    currentPrice?: number
): number | undefined {
    if (currentPrice === undefined) {
        return undefined
    }

    if (side === "short") {
        return quantity * (entryPrice - currentPrice)
    }

    return quantity * (currentPrice - entryPrice)
}

export function resolveDryRunOpeningCashDelta(position: Position): number {
    const notional = position.quantity * position.entryPrice
    return position.side === "short" ? notional : -notional
}

export function resolveDryRunCashDelta(
    side: "buy" | "sell",
    quantity: number,
    fillPrice: number
): number {
    const notional = quantity * fillPrice
    return side === "buy" ? -notional : notional
}

export function resolveDryRunRealizedPnl(
    existing: Position,
    closeSide: "buy" | "sell",
    closedQty: number,
    fillPrice: number
): number {
    if (existing.side === "long" && closeSide === "sell") {
        return closedQty * (fillPrice - existing.entryPrice)
    }

    if (existing.side === "short" && closeSide === "buy") {
        return closedQty * (existing.entryPrice - fillPrice)
    }

    return 0
}

function readNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}
