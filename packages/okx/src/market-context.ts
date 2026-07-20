import {
    formatExecutionCostEvidence,
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

export interface OKXSetupEvidence {
    instrument: string
    fundingRate: number
    absoluteFundingRate: number
    clearCrowdingThreshold: number
    buildingCrowdingThreshold: number
    executionCostSpreadBps?: number
    executionCostRatioToBaseline?: number
    executionCostBaselineSampleCount?: number
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
            return `${formatExecutionCostEvidence(snapshot.executionCost)}, mark ${snapshot.markPrice.toFixed(2)}, funding ${funding}`
        })

    return `Current OKX swap execution context: ${segments.join(" | ")}`
}

export function createOKXSetupEvidenceLine(
    snapshots: readonly OKXMarketSnapshot[],
    options: {
        fundingRateThreshold: number
    }
): string | null {
    if (snapshots.length === 0) {
        return null
    }

    const evidence = collectOKXSetupEvidence(snapshots, options)
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((entry) =>
            `${entry.instrument} funding=${formatFundingRate(entry.fundingRate)}, absFunding=${formatFundingRate(entry.absoluteFundingRate)}, clearThreshold=${formatFundingRate(entry.clearCrowdingThreshold)}, buildingThreshold=${formatFundingRate(entry.buildingCrowdingThreshold)}, executionCostSpreadBps=${formatOptionalNumber(entry.executionCostSpreadBps)}, executionCostRatioToBaseline=${formatOptionalNumber(entry.executionCostRatioToBaseline)}, executionCostBaselineSamples=${entry.executionCostBaselineSampleCount ?? "n/a"}`
        )

    return `Deterministic OKX setup evidence: ${evidence.join(" | ")}`
}

export function collectOKXSetupEvidence(
    snapshots: readonly OKXMarketSnapshot[],
    options: {
        fundingRateThreshold: number
    }
): OKXSetupEvidence[] {
    const clearCrowdingThreshold = Math.max(options.fundingRateThreshold, 0)
    const buildingCrowdingThreshold = clearCrowdingThreshold > 0
        ? clearCrowdingThreshold * 0.67
        : Number.POSITIVE_INFINITY

    return snapshots.map((snapshot) => {
        const absFunding = Math.abs(snapshot.fundingRate)
        return {
            instrument: snapshot.instrument,
            fundingRate: snapshot.fundingRate,
            absoluteFundingRate: absFunding,
            clearCrowdingThreshold,
            buildingCrowdingThreshold,
            executionCostSpreadBps: snapshot.executionCost.metrics.spreadBps,
            executionCostRatioToBaseline: snapshot.executionCost.ratioToBaseline,
            executionCostBaselineSampleCount: snapshot.executionCost.baseline?.sampleCount,
        }
    })
}

function formatOptionalNumber(value: number | undefined): string {
    return value === undefined ? "n/a" : String(value)
}

function formatFundingRate(rate: number): string {
    const pct = rate * 100
    const sign = pct > 0 ? "+" : ""
    return `${sign}${pct.toFixed(4)}%`
}
