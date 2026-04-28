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

export interface OKXSetupClassification {
    instrument: string
    state: "blocked" | "no_setup" | "watchlist" | "qualified"
    families: string[]
    reasons: string[]
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

export function createOKXSetupClassifierLine(
    snapshots: readonly OKXMarketSnapshot[],
    options: {
        fundingRateThreshold: number
    }
): string | null {
    if (snapshots.length === 0) {
        return null
    }

    const classifications = classifyOKXSetups(snapshots, options)
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((classification) =>
            `${classification.instrument} ${classification.state}; families=${classification.families.join(",") || "none"}; reasons=${classification.reasons.join("; ")}`
        )

    return `Deterministic OKX setup classifier: ${classifications.join(" | ")}`
}

export function classifyOKXSetups(
    snapshots: readonly OKXMarketSnapshot[],
    options: {
        fundingRateThreshold: number
    }
): OKXSetupClassification[] {
    const clearCrowdingThreshold = Math.max(options.fundingRateThreshold, 0)
    const buildingCrowdingThreshold = clearCrowdingThreshold > 0
        ? clearCrowdingThreshold * 0.67
        : Number.POSITIVE_INFINITY

    return snapshots.map((snapshot) => {
        if (snapshot.executionCost.blockNewEntries) {
            return {
                instrument: snapshot.instrument,
                state: "blocked",
                families: [],
                reasons: [`execution cost ${snapshot.executionCost.status}: ${snapshot.executionCost.summary}`],
            }
        }

        const absFunding = Math.abs(snapshot.fundingRate)
        if (absFunding >= clearCrowdingThreshold && clearCrowdingThreshold > 0) {
            return {
                instrument: snapshot.instrument,
                state: "watchlist",
                families: ["funding_crowding_extreme"],
                reasons: [
                    `funding ${formatFundingRate(snapshot.fundingRate)} is at or beyond configured crowding threshold ${formatFundingRate(clearCrowdingThreshold)}`,
                    "requires price failure, reclaim, absorption, breakout failure, volatility expansion, or news-overreaction confirmation before entry",
                ],
            }
        }

        if (absFunding >= buildingCrowdingThreshold) {
            return {
                instrument: snapshot.instrument,
                state: "watchlist",
                families: ["funding_crowding_building"],
                reasons: [
                    `funding ${formatFundingRate(snapshot.fundingRate)} is building but not extreme`,
                    "requires one named non-funding setup family before entry",
                ],
            }
        }

        return {
            instrument: snapshot.instrument,
            state: "no_setup",
            families: [],
            reasons: [
                `funding ${formatFundingRate(snapshot.fundingRate)} is ordinary versus configured threshold ${formatFundingRate(clearCrowdingThreshold)}`,
                "liquidation sweep, failed breakout, volatility expansion, and news-overreaction families require research or order-book confirmation",
            ],
        }
    })
}

function formatFundingRate(rate: number): string {
    const pct = rate * 100
    const sign = pct > 0 ? "+" : ""
    return `${sign}${pct.toFixed(4)}%`
}
