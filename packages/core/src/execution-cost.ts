import type { VenueApp } from "./types"

export const EXECUTION_COST_UNITS = ["price", "probability", "pips", "points"] as const
export type ExecutionCostUnit = typeof EXECUTION_COST_UNITS[number]

export const EXECUTION_COST_INSTRUMENT_CLASSES = [
    "equity",
    "equity_option",
    "option_structure",
    "fx",
    "metal",
    "index",
    "perpetual_swap",
    "prediction_market",
] as const
export type ExecutionCostInstrumentClass = typeof EXECUTION_COST_INSTRUMENT_CLASSES[number]

export const EXECUTION_COST_STATUSES = ["normal", "elevated", "blocked", "unavailable"] as const
export type ExecutionCostStatus = typeof EXECUTION_COST_STATUSES[number]

export const EXECUTION_COST_BASELINE_SOURCES = ["rolling_observed", "burst_observed"] as const
export type ExecutionCostBaselineSource = typeof EXECUTION_COST_BASELINE_SOURCES[number]

export interface ExecutionCostSnapshot {
    app: VenueApp
    instrument: string
    instrumentClass: ExecutionCostInstrumentClass
    capturedAt: number
    bestBid?: number
    bestAsk?: number
    midpoint?: number
    referencePrice?: number
    absoluteSpread?: number
    nativeSpread?: number
    nativeSpreadUnit: ExecutionCostUnit
    liquidityWarning?: boolean
}

export interface ExecutionCostMetrics {
    app: VenueApp
    instrument: string
    instrumentClass: ExecutionCostInstrumentClass
    capturedAt: number
    regimeKey: string
    bestBid?: number
    bestAsk?: number
    midpoint?: number
    referencePrice?: number
    absoluteSpread?: number
    nativeSpread?: number
    nativeSpreadUnit: ExecutionCostUnit
    spreadPercent?: number
    spreadBps?: number
    liquidityWarning: boolean
}

export interface ExecutionCostBaseline {
    app: VenueApp
    instrument: string
    instrumentClass: ExecutionCostInstrumentClass
    regimeKey: string
    nativeSpreadUnit: ExecutionCostUnit
    sampleCount: number
    source: ExecutionCostBaselineSource
    lastObservedAt: number
    absoluteSpread?: number
    nativeSpread?: number
    spreadPercent?: number
    spreadBps?: number
}

export interface ExecutionCostAssessment {
    metrics: ExecutionCostMetrics
    baseline?: ExecutionCostBaseline
    ratioToBaseline?: number
    status: ExecutionCostStatus
    blockNewEntries: boolean
    summary: string
}

const EXECUTION_COST_WARMUP_SAMPLES = 5
const EXECUTION_COST_WARN_RATIO = 1.5
const EXECUTION_COST_BLOCK_RATIO = 2
const EXECUTION_COST_ABSOLUTE_THRESHOLDS: Partial<Record<
    ExecutionCostInstrumentClass,
    {
        warnSpreadPercent?: number
        blockSpreadPercent?: number
    }
>> = {
    prediction_market: {
        warnSpreadPercent: 8,
        blockSpreadPercent: 15,
    },
}

export class ExecutionCostTracker {
    private readonly baselines = new Map<string, ExecutionCostBaseline>()

    needsWarmup(snapshot: ExecutionCostSnapshot): boolean {
        const metrics = resolveExecutionCostMetrics(snapshot)
        const baseline = this.baselines.get(buildBaselineKey(metrics))
        return !baseline || baseline.sampleCount < EXECUTION_COST_WARMUP_SAMPLES
    }

    assessSnapshot(snapshot: ExecutionCostSnapshot): ExecutionCostAssessment {
        return this.assessSnapshots([snapshot])
    }

    assessSnapshots(snapshots: ExecutionCostSnapshot[]): ExecutionCostAssessment {
        if (snapshots.length === 0) {
            throw new Error("ExecutionCostTracker.assessSnapshots requires at least one snapshot")
        }

        const currentMetrics = resolveExecutionCostMetrics(snapshots[0]!)
        const rollingBaseline = this.baselines.get(buildBaselineKey(currentMetrics))
        const burstBaseline = rollingBaseline && rollingBaseline.sampleCount >= EXECUTION_COST_WARMUP_SAMPLES
            ? undefined
            : buildBurstBaseline(snapshots)
        const baseline = rollingBaseline && rollingBaseline.sampleCount >= EXECUTION_COST_WARMUP_SAMPLES
            ? rollingBaseline
            : burstBaseline
        const assessment = assessExecutionCost(currentMetrics, baseline)

        for (const snapshot of snapshots) {
            this.recordSnapshot(snapshot)
        }

        return assessment
    }

    private recordSnapshot(snapshot: ExecutionCostSnapshot): void {
        const metrics = resolveExecutionCostMetrics(snapshot)
        const key = buildBaselineKey(metrics)
        const existing = this.baselines.get(key)

        if (!existing) {
            this.baselines.set(key, {
                app: metrics.app,
                instrument: metrics.instrument,
                instrumentClass: metrics.instrumentClass,
                regimeKey: metrics.regimeKey,
                nativeSpreadUnit: metrics.nativeSpreadUnit,
                sampleCount: 1,
                source: "rolling_observed",
                lastObservedAt: metrics.capturedAt,
                absoluteSpread: metrics.absoluteSpread,
                nativeSpread: metrics.nativeSpread,
                spreadPercent: metrics.spreadPercent,
                spreadBps: metrics.spreadBps,
            })
            return
        }

        const sampleCount = existing.sampleCount + 1
        this.baselines.set(key, {
            ...existing,
            sampleCount,
            lastObservedAt: Math.max(existing.lastObservedAt, metrics.capturedAt),
            absoluteSpread: nextRunningAverage(existing.absoluteSpread, metrics.absoluteSpread, sampleCount),
            nativeSpread: nextRunningAverage(existing.nativeSpread, metrics.nativeSpread, sampleCount),
            spreadPercent: nextRunningAverage(existing.spreadPercent, metrics.spreadPercent, sampleCount),
            spreadBps: nextRunningAverage(existing.spreadBps, metrics.spreadBps, sampleCount),
        })
    }
}

export function resolveExecutionCostMetrics(snapshot: ExecutionCostSnapshot): ExecutionCostMetrics {
    const midpoint = snapshot.midpoint ?? resolveMidpoint(snapshot.bestBid, snapshot.bestAsk)
    const referencePrice = snapshot.referencePrice ?? midpoint
    const absoluteSpread = snapshot.absoluteSpread ?? resolveAbsoluteSpread(snapshot.bestBid, snapshot.bestAsk)
    const nativeSpread = snapshot.nativeSpread ?? (
        snapshot.nativeSpreadUnit === "price" || snapshot.nativeSpreadUnit === "probability"
            ? absoluteSpread
            : undefined
    )
    const spreadPercent = referencePrice !== undefined && referencePrice > 0 && absoluteSpread !== undefined
        ? (absoluteSpread / referencePrice) * 100
        : undefined
    const spreadBps = spreadPercent !== undefined
        ? spreadPercent * 100
        : undefined

    return {
        app: snapshot.app,
        instrument: snapshot.instrument,
        instrumentClass: snapshot.instrumentClass,
        capturedAt: snapshot.capturedAt,
        regimeKey: resolveExecutionCostRegime(snapshot.app, snapshot.capturedAt),
        bestBid: snapshot.bestBid,
        bestAsk: snapshot.bestAsk,
        midpoint,
        referencePrice,
        absoluteSpread,
        nativeSpread,
        nativeSpreadUnit: snapshot.nativeSpreadUnit,
        spreadPercent,
        spreadBps,
        liquidityWarning: snapshot.liquidityWarning === true,
    }
}

export function assessExecutionCost(
    metrics: ExecutionCostMetrics,
    baseline?: ExecutionCostBaseline
): ExecutionCostAssessment {
    if (metrics.liquidityWarning) {
        return buildAssessment(metrics, baseline, undefined, "blocked", true)
    }

    const absoluteStatus = resolveAbsoluteExecutionCostStatus(metrics)
    if (absoluteStatus === "blocked") {
        const ratioToBaseline = resolveBaselineRatio(metrics, baseline)
        return buildAssessment(metrics, baseline, ratioToBaseline, "blocked", true)
    }

    const ratioToBaseline = resolveBaselineRatio(metrics, baseline)
    if (ratioToBaseline === undefined) {
        const status = metrics.absoluteSpread === undefined
            ? "unavailable"
            : absoluteStatus ?? "normal"
        return buildAssessment(metrics, baseline, undefined, status, false)
    }

    if (ratioToBaseline > EXECUTION_COST_BLOCK_RATIO) {
        return buildAssessment(metrics, baseline, ratioToBaseline, "blocked", true)
    }

    if (ratioToBaseline > EXECUTION_COST_WARN_RATIO) {
        return buildAssessment(metrics, baseline, ratioToBaseline, "elevated", false)
    }

    return buildAssessment(metrics, baseline, ratioToBaseline, absoluteStatus ?? "normal", false)
}

export function formatExecutionCostMetrics(metrics: ExecutionCostMetrics): string {
    const native = metrics.nativeSpread !== undefined
        ? `${formatMetricValue(metrics.nativeSpread)} ${metrics.nativeSpreadUnit}`
        : "spread unavailable"
    const percent = metrics.spreadPercent !== undefined
        ? `${metrics.spreadPercent.toFixed(3)}%`
        : "n/a"
    const bps = metrics.spreadBps !== undefined
        ? `${metrics.spreadBps.toFixed(2)} bps`
        : "n/a"

    return `${metrics.instrument} ${native}, ${bps}, ${percent}`
}

export function formatExecutionCostAssessment(assessment: ExecutionCostAssessment): string {
    const baseline = assessment.baseline
    const baselineText = baseline
        ? `baseline ${baseline.nativeSpread !== undefined ? `${formatMetricValue(baseline.nativeSpread)} ${baseline.nativeSpreadUnit}` : "n/a"} (${baseline.spreadBps !== undefined ? `${baseline.spreadBps.toFixed(2)} bps` : "n/a"}, ${baseline.source}, ${baseline.regimeKey}, n=${baseline.sampleCount})`
        : "baseline unavailable"
    const ratioText = assessment.ratioToBaseline !== undefined
        ? `${assessment.ratioToBaseline.toFixed(2)}x baseline`
        : "ratio unavailable"

    return `${formatExecutionCostMetrics(assessment.metrics)} vs ${baselineText}, ${ratioText}, status ${assessment.status.toUpperCase()}`
}

export function createExecutionCostContextLine(
    label: string,
    assessments: readonly ExecutionCostAssessment[]
): string | null {
    if (assessments.length === 0) {
        return null
    }

    const segments = [...assessments]
        .sort((left, right) => left.metrics.instrument.localeCompare(right.metrics.instrument))
        .map((assessment) => formatExecutionCostAssessment(assessment))

    return `${label}: ${segments.join(" | ")}`
}

function buildAssessment(
    metrics: ExecutionCostMetrics,
    baseline: ExecutionCostBaseline | undefined,
    ratioToBaseline: number | undefined,
    status: ExecutionCostStatus,
    blockNewEntries: boolean
): ExecutionCostAssessment {
    const summary = formatExecutionCostAssessment({
        metrics,
        baseline,
        ratioToBaseline,
        status,
        blockNewEntries,
        summary: "",
    })

    return {
        metrics,
        baseline,
        ratioToBaseline,
        status,
        blockNewEntries,
        summary,
    }
}

function buildBurstBaseline(snapshots: ExecutionCostSnapshot[]): ExecutionCostBaseline | undefined {
    if (snapshots.length === 0) {
        return undefined
    }

    const metrics = snapshots.map((snapshot) => resolveExecutionCostMetrics(snapshot))
    const first = metrics[0]!

    return {
        app: first.app,
        instrument: first.instrument,
        instrumentClass: first.instrumentClass,
        regimeKey: first.regimeKey,
        nativeSpreadUnit: first.nativeSpreadUnit,
        sampleCount: metrics.length,
        source: "burst_observed",
        lastObservedAt: Math.max(...metrics.map((entry) => entry.capturedAt)),
        absoluteSpread: median(metrics.map((entry) => entry.absoluteSpread)),
        nativeSpread: median(metrics.map((entry) => entry.nativeSpread)),
        spreadPercent: median(metrics.map((entry) => entry.spreadPercent)),
        spreadBps: median(metrics.map((entry) => entry.spreadBps)),
    }
}

function resolveBaselineRatio(
    metrics: ExecutionCostMetrics,
    baseline?: ExecutionCostBaseline
): number | undefined {
    if (!baseline) {
        return undefined
    }

    if (
        metrics.spreadBps !== undefined &&
        baseline.spreadBps !== undefined &&
        baseline.spreadBps > 0
    ) {
        return metrics.spreadBps / baseline.spreadBps
    }

    if (
        metrics.spreadPercent !== undefined &&
        baseline.spreadPercent !== undefined &&
        baseline.spreadPercent > 0
    ) {
        return metrics.spreadPercent / baseline.spreadPercent
    }

    if (
        metrics.nativeSpread !== undefined &&
        baseline.nativeSpread !== undefined &&
        baseline.nativeSpread > 0 &&
        metrics.nativeSpreadUnit === baseline.nativeSpreadUnit
    ) {
        return metrics.nativeSpread / baseline.nativeSpread
    }

    return undefined
}

function resolveAbsoluteExecutionCostStatus(
    metrics: ExecutionCostMetrics
): Exclude<ExecutionCostStatus, "unavailable"> | undefined {
    const thresholds = EXECUTION_COST_ABSOLUTE_THRESHOLDS[metrics.instrumentClass]
    if (!thresholds) {
        return undefined
    }

    if (
        thresholds.blockSpreadPercent !== undefined &&
        metrics.spreadPercent !== undefined &&
        metrics.spreadPercent >= thresholds.blockSpreadPercent
    ) {
        return "blocked"
    }

    if (
        thresholds.warnSpreadPercent !== undefined &&
        metrics.spreadPercent !== undefined &&
        metrics.spreadPercent >= thresholds.warnSpreadPercent
    ) {
        return "elevated"
    }

    return undefined
}

function buildBaselineKey(metrics: ExecutionCostMetrics): string {
    return [
        metrics.app,
        metrics.instrument,
        metrics.instrumentClass,
        metrics.regimeKey,
    ].join("::")
}

function resolveExecutionCostRegime(app: VenueApp, capturedAt: number): string {
    const date = new Date(capturedAt)
    const day = date.getUTCDay()
    const hour = date.getUTCHours()
    const dayBucket = day === 0 || day === 6 ? "weekend" : "weekday"
    const sessionBucket = hour >= 13 && hour < 21
        ? "us"
        : hour >= 7 && hour < 13
            ? "europe"
            : "asia"

    return `${app}:${dayBucket}:${sessionBucket}`
}

function resolveMidpoint(bestBid?: number, bestAsk?: number): number | undefined {
    if (bestBid === undefined || bestAsk === undefined) {
        return undefined
    }

    return (bestBid + bestAsk) / 2
}

function resolveAbsoluteSpread(bestBid?: number, bestAsk?: number): number | undefined {
    if (bestBid === undefined || bestAsk === undefined) {
        return undefined
    }

    return Math.max(bestAsk - bestBid, 0)
}

function nextRunningAverage(
    existing: number | undefined,
    next: number | undefined,
    sampleCount: number
): number | undefined {
    if (next === undefined) {
        return existing
    }

    if (existing === undefined || sampleCount <= 1) {
        return next
    }

    return existing + (next - existing) / sampleCount
}

function median(values: Array<number | undefined>): number | undefined {
    const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    if (filtered.length === 0) {
        return undefined
    }

    const sorted = [...filtered].sort((left, right) => left - right)
    const midpoint = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 1) {
        return sorted[midpoint]
    }

    return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
}

function formatMetricValue(value: number): string {
    if (Math.abs(value) >= 100) {
        return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
    }

    if (Math.abs(value) >= 10) {
        return value.toFixed(1)
    }

    if (Math.abs(value) >= 1) {
        return value.toFixed(2)
    }

    return value.toFixed(4)
}
