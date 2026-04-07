export interface BinanceMarketSnapshot {
    instrument: string
    bid: number
    ask: number
    markPrice: number
    spreadPercent: number
    fundingRate: number
}

export function createBinanceMarketContextLine(
    snapshots: readonly BinanceMarketSnapshot[]
): string | null {
    if (snapshots.length === 0) {
        return null
    }

    const segments = [...snapshots]
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((snapshot) => {
            const spreadPct = `${snapshot.spreadPercent.toFixed(3)}%`
            const funding = formatFundingRate(snapshot.fundingRate)
            return `${snapshot.instrument} mark ${snapshot.markPrice.toFixed(2)}, spread ${spreadPct}, funding ${funding}`
        })

    return `Current crypto market context: ${segments.join(" | ")}`
}

function formatFundingRate(rate: number): string {
    const pct = rate * 100
    const sign = pct > 0 ? "+" : ""
    return `${sign}${pct.toFixed(4)}%`
}
