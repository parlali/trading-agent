import {
    formatExecutionCostAssessment,
    type ExecutionCostAssessment,
} from "@valiq-trading/core"

export interface OKXMarketSnapshot {
    instrument: string
    bid: number
    ask: number
    markPrice: number
    fundingRate: number
    executionCost: ExecutionCostAssessment
}

export function createOKXMarketContextLine(
    snapshots: readonly OKXMarketSnapshot[]
): string | null {
    if (snapshots.length === 0) {
        return null
    }

    const segments = [...snapshots]
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((snapshot) => {
            const funding = formatFundingRate(snapshot.fundingRate)
            return `${formatExecutionCostAssessment(snapshot.executionCost)}, mark ${snapshot.markPrice.toFixed(2)}, funding ${funding}`
        })

    return `Current OKX swap execution context: ${segments.join(" | ")}`
}

function formatFundingRate(rate: number): string {
    const pct = rate * 100
    const sign = pct > 0 ? "+" : ""
    return `${sign}${pct.toFixed(4)}%`
}
