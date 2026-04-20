import type {
    PendingOrderContext,
    RunSystemContextDigest,
    StrategyRiskState,
} from "./types"
import type { RecentTradeDigest } from "./risk-governance"

const MAX_BLOCKED_INSTRUMENTS = 20
const MAX_FORCED_EXIT_INSTRUMENTS = 20
const MAX_PENDING_ORDERS = 12
const MAX_HANDOFF_CHARS = 6000

function trimArray<T>(values: T[], maxItems: number): T[] {
    return values.slice(0, maxItems)
}

export function truncateHandoffSummary(summary: string): string {
    if (summary.length <= MAX_HANDOFF_CHARS) {
        return summary
    }

    return `${summary.slice(0, MAX_HANDOFF_CHARS)}\n\n[truncated for bounded handoff context]`
}

export function buildRunSystemContextDigest(args: {
    generatedAt: number
    riskState: StrategyRiskState
    recentTrades: RecentTradeDigest
    pendingOrders: PendingOrderContext[]
}): RunSystemContextDigest {
    const pendingOrders = trimArray(args.pendingOrders, MAX_PENDING_ORDERS).map((order) => ({
        orderId: order.orderId,
        instrument: order.instrument,
        action: order.action,
        status: order.status,
        cancelAt: order.cancelAt,
    }))

    return {
        schemaVersion: 1,
        generatedAt: args.generatedAt,
        risk: {
            safetyState: args.riskState.safetyState,
            dayRealizedPnl: args.riskState.day.realizedPnl,
            weekRealizedPnl: args.riskState.week.realizedPnl,
            dayDrawdownLimit: args.riskState.day.limit,
            weekDrawdownLimit: args.riskState.week.limit,
            cooldownActive: args.riskState.cooldown.active,
            cooldownReason: args.riskState.cooldown.reason,
            cooldownExpiresAt: args.riskState.cooldown.expiresAt,
            blockedInstruments: trimArray(args.riskState.blockedInstruments, MAX_BLOCKED_INSTRUMENTS),
            forcedExitClusterInstruments: trimArray(args.riskState.forcedExitClusterInstruments, MAX_FORCED_EXIT_INSTRUMENTS),
            unresolvedExecutionFaultCount: args.riskState.unresolvedExecutionFaultCount,
        },
        recentTrades: {
            dayEntries: args.recentTrades.dayEntries,
            dayCloses: args.recentTrades.dayCloses,
            dayForcedExits: args.recentTrades.dayForcedExits,
            dayRejectedOrTerminal: args.recentTrades.dayRejectedOrTerminal,
            weekRealizedPnl: args.recentTrades.weekRealizedPnl,
            closeOutStreakDirection: args.recentTrades.closeOutStreakDirection,
            closeOutStreakCount: args.recentTrades.closeOutStreakCount,
        },
        pendingOrders,
    }
}

export function formatRunSystemContextDigestLines(digest: RunSystemContextDigest): string[] {
    const lines = [
        `Risk posture: ${digest.risk.safetyState}.`,
        `Recent trade digest (same day): entries ${digest.recentTrades.dayEntries}, closes ${digest.recentTrades.dayCloses}, forced exits ${digest.recentTrades.dayForcedExits}, rejected/terminal actions ${digest.recentTrades.dayRejectedOrTerminal}.`,
        `Recent trade digest (same week): realized PnL ${digest.recentTrades.weekRealizedPnl.toFixed(2)} (risk state ${digest.risk.weekRealizedPnl.toFixed(2)}).`,
    ]

    if (digest.risk.dayDrawdownLimit !== undefined) {
        lines.push(
            `Daily realized PnL ${digest.risk.dayRealizedPnl.toFixed(2)} vs max drawdown ${digest.risk.dayDrawdownLimit.toFixed(2)}.`
        )
    }

    if (digest.risk.weekDrawdownLimit !== undefined) {
        lines.push(
            `Weekly realized PnL ${digest.risk.weekRealizedPnl.toFixed(2)} vs max drawdown ${digest.risk.weekDrawdownLimit.toFixed(2)}.`
        )
    }

    if (digest.recentTrades.closeOutStreakDirection && digest.recentTrades.closeOutStreakCount > 0) {
        lines.push(
            `Current close-out streak: ${digest.recentTrades.closeOutStreakCount} ${digest.recentTrades.closeOutStreakDirection}${digest.recentTrades.closeOutStreakCount > 1 ? "s" : ""}.`
        )
    }

    if (digest.risk.cooldownActive && digest.risk.cooldownExpiresAt !== undefined) {
        lines.push(
            `Cooldown active (${digest.risk.cooldownReason ?? "risk"}), expires at ${new Date(digest.risk.cooldownExpiresAt).toISOString()}.`
        )
    }

    if (digest.risk.blockedInstruments.length > 0) {
        lines.push(
            `Blocked instruments due to safety governance constraints: ${digest.risk.blockedInstruments.join(", ")}.`
        )
    }

    if (digest.risk.forcedExitClusterInstruments.length > 0) {
        lines.push(
            `Re-entry guard active after repeated forced exits for: ${digest.risk.forcedExitClusterInstruments.join(", ")}.`
        )
    }

    if (digest.risk.unresolvedExecutionFaultCount > 0) {
        lines.push(
            `Unresolved execution safety faults: ${digest.risk.unresolvedExecutionFaultCount}.`
        )
    }

    if (digest.pendingOrders.length > 0) {
        const pendingSummary = digest.pendingOrders
            .map((order) => `${order.orderId}:${order.status}`)
            .join(", ")
        lines.push(`Active pending-order digest: ${pendingSummary}.`)
    }

    return lines
}
