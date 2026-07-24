import type { DecisionRecord, OrderIntent } from "@valiq-trading/core"

export type CounterfactualDirection = "long" | "short"
export type CounterfactualKind = "taken" | "unfilled" | "declined"
export type CounterfactualResolution = "tp" | "sl" | "horizon_exit" | "unfilled" | "unresolvable"

export interface CounterfactualPriceSample {
    timestamp: number
    open?: number
    high: number
    low: number
    close: number
    bid?: number
    ask?: number
    source?: string
}

export interface CounterfactualPriceSeries {
    instrument: string
    granularity: string
    samples: CounterfactualPriceSample[]
    entrySamples?: CounterfactualPriceSample[]
}

export interface CounterfactualResolutionRow {
    runId: string
    book: string
    kind: CounterfactualKind
    direction?: CounterfactualDirection
    entryPx?: number
    exitPx?: number
    rMultiple?: number
    percent?: number
    resolution: CounterfactualResolution
    granularity: string
    conservativeFlag: boolean
    instrument?: string
    orderId?: string
    reason?: string
    resolvedAt?: string
    actualPnl?: number
}

export interface CounterfactualPriceSource {
    load(instrument: string, fromAt: number, toAt: number): Promise<CounterfactualPriceSeries>
}

export interface ForecastLevels {
    stopLoss: number
    takeProfit: number
}

export interface BookSummaryRow {
    book: string
    takenCount: number
    takenAvgR?: number
    unfilledCount: number
    unfilledMissedR: number
    declinedCount: number
    declinedForegoneR: number
    conservativeFlagCount: number
    unresolvableCount: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const HORIZON_CAP_MS = DAY_MS
const OKX_HISTORY_CANDLE_LIMIT = 100
const OKX_HISTORY_MAX_PAGES = 50
const OKX_BASE_URL = "https://www.okx.com"

export class OKXHistoryCandlePriceSource implements CounterfactualPriceSource {
    readonly granularity = "okx_5m_candles"

    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    async load(instrument: string, fromAt: number, toAt: number): Promise<CounterfactualPriceSeries> {
        const candles = await this.fetchCandles(instrument, fromAt, toAt)

        return {
            instrument,
            granularity: this.granularity,
            samples: candles,
            entrySamples: candles,
        }
    }

    private async fetchCandles(
        instrument: string,
        fromAt: number,
        toAt: number
    ): Promise<CounterfactualPriceSample[]> {
        const byTimestamp = new Map<number, CounterfactualPriceSample>()
        let firstBatch = await this.fetchCandleBatch(instrument)
        if (firstBatch.length === 0) {
            return []
        }

        for (const sample of firstBatch) {
            byTimestamp.set(sample.timestamp, sample)
        }

        let earliest = resolveEarliestTimestamp(firstBatch)
        let cursorMode: "after" | "before" | undefined

        for (let page = 1; page < OKX_HISTORY_MAX_PAGES && earliest !== undefined && earliest > fromAt; page++) {
            let batch = cursorMode === undefined
                ? await this.fetchCandleBatch(instrument, { after: earliest })
                : await this.fetchCandleBatch(instrument, { [cursorMode]: earliest })
            let batchEarliest = resolveEarliestTimestamp(batch)

            if (cursorMode === undefined && (batchEarliest === undefined || batchEarliest >= earliest)) {
                batch = await this.fetchCandleBatch(instrument, { before: earliest })
                batchEarliest = resolveEarliestTimestamp(batch)
                if (batchEarliest !== undefined && batchEarliest < earliest) {
                    cursorMode = "before"
                }
            } else if (cursorMode === undefined) {
                cursorMode = "after"
            }

            if (batchEarliest === undefined || batchEarliest >= earliest) {
                break
            }

            for (const sample of batch) {
                byTimestamp.set(sample.timestamp, sample)
            }
            earliest = batchEarliest
            firstBatch = batch
        }

        return Array.from(byTimestamp.values())
            .filter((sample) => sample.timestamp >= fromAt && sample.timestamp <= toAt)
            .sort((left, right) => left.timestamp - right.timestamp)
    }

    private async fetchCandleBatch(
        instrument: string,
        cursor?: {
            after?: number
            before?: number
        }
    ): Promise<CounterfactualPriceSample[]> {
        const url = new URL("/api/v5/market/history-candles", OKX_BASE_URL)
        url.searchParams.set("instId", instrument)
        url.searchParams.set("bar", "5m")
        url.searchParams.set("limit", String(OKX_HISTORY_CANDLE_LIMIT))
        if (cursor?.after !== undefined) {
            url.searchParams.set("after", String(cursor.after))
        }
        if (cursor?.before !== undefined) {
            url.searchParams.set("before", String(cursor.before))
        }

        const response = await this.fetchImpl(url)
        if (!response.ok) {
            throw new Error(`OKX history-candles failed for ${instrument}: HTTP ${response.status}`)
        }

        const payload = await response.json()
        if (!isRecord(payload) || payload.code !== "0" || !Array.isArray(payload.data)) {
            throw new Error(`OKX history-candles returned an invalid payload for ${instrument}`)
        }

        return payload.data
            .map((row) => parseOKXCandleRow(row))
            .filter((sample): sample is CounterfactualPriceSample => sample !== undefined)
            .sort((left, right) => left.timestamp - right.timestamp)
    }
}

export function buildMT5SelfSampledPriceSeries(
    instrument: string,
    samples: CounterfactualPriceSample[]
): CounterfactualPriceSeries {
    const sorted = normalizePriceSamples(samples)
    const intervals: CounterfactualPriceSample[] = []

    for (let index = 1; index < sorted.length; index++) {
        const previous = sorted[index - 1]
        const current = sorted[index]
        if (!previous || !current) {
            continue
        }

        intervals.push({
            timestamp: current.timestamp,
            open: resolveSampleMidpoint(previous),
            high: Math.max(previous.high, current.high),
            low: Math.min(previous.low, current.low),
            close: resolveSampleMidpoint(current),
            bid: current.bid,
            ask: current.ask,
            source: current.source,
        })
    }

    return {
        instrument,
        granularity: "mt5_self_sampled_consecutive_range",
        samples: intervals,
        entrySamples: sorted,
    }
}

export function normalizePriceSamples(samples: CounterfactualPriceSample[]): CounterfactualPriceSample[] {
    return samples
        .filter((sample) =>
            Number.isFinite(sample.timestamp) &&
            Number.isFinite(sample.high) &&
            Number.isFinite(sample.low) &&
            Number.isFinite(sample.close)
        )
        .sort((left, right) => left.timestamp - right.timestamp)
}

export function resolveCounterfactualEntry(args: {
    runId: string
    book: string
    kind: "unfilled"
    instrument: string
    direction: CounterfactualDirection
    orderType?: OrderIntent["orderType"]
    entryPx: number | undefined
    stopLoss: number | undefined
    takeProfit: number | undefined
    proposedAt: number
    fillDeadlineAt: number
    horizonExitAt: number
    priceSeries: CounterfactualPriceSeries
    orderId?: string
}): CounterfactualResolutionRow {
    const base = buildBaseRow(args)

    if (!isFinitePositive(args.entryPx)) {
        return markUnresolvable(base, "entry price is missing or non-positive")
    }
    if (!hasValidTradeLevels(args.direction, args.entryPx, args.stopLoss, args.takeProfit)) {
        return markUnresolvable(base, "SL/TP levels are missing or not on the correct side of entry")
    }

    const samples = normalizePriceSamples(args.priceSeries.samples)
    const fill = findEntryFill({
        samples,
        direction: args.direction,
        orderType: args.orderType,
        entryPx: args.entryPx,
        afterAt: args.proposedAt,
        deadlineAt: args.fillDeadlineAt,
    })

    if (!fill) {
        return {
            ...base,
            entryPx: args.entryPx,
            resolution: "unfilled",
            reason: "entry price was not traded through before cancel or expiry",
        }
    }

    return resolveFilledCounterfactualTrade({
        ...base,
        direction: args.direction,
        entryPx: args.entryPx,
        stopLoss: args.stopLoss!,
        takeProfit: args.takeProfit!,
        samples,
        startAt: fill.timestamp,
        horizonExitAt: args.horizonExitAt,
        conservativeFlag: false,
    })
}

export function resolveDeclinedCounterfactual(args: {
    runId: string
    book: string
    instrument: string
    decisionRecord: DecisionRecord | undefined
    runStartedAt: number
    priceSeries: CounterfactualPriceSeries
}): CounterfactualResolutionRow | undefined {
    const forecast = args.decisionRecord?.forecast
    const rawDirection = forecast?.direction
    if (args.decisionRecord?.decision !== "no_trade" || rawDirection === undefined || rawDirection === "neutral") {
        return undefined
    }

    const direction = rawDirection
    const base: CounterfactualResolutionRow = {
        runId: args.runId,
        book: args.book,
        kind: "declined",
        direction,
        instrument: args.instrument,
        resolution: "unresolvable",
        granularity: args.priceSeries.granularity,
        conservativeFlag: false,
    }
    const entrySample = findNextPriceSample(args.priceSeries.entrySamples ?? args.priceSeries.samples, args.runStartedAt)

    if (!entrySample) {
        return markUnresolvable(base, "no next sampled price after run")
    }

    const entryPx = resolveEntryPriceFromSample(entrySample, direction)
    if (!isFinitePositive(entryPx)) {
        return markUnresolvable({ ...base, entryPx }, "next sampled entry price is missing")
    }

    const levels = parseForecastLevels({
        forecast,
        direction,
        entryPx,
    })
    if (!levels) {
        return markUnresolvable({ ...base, entryPx }, "forecast invalidation or expected move was not parseable")
    }

    const horizonMs = parseForecastHorizonMs(forecast?.horizon, args.runStartedAt) ?? HORIZON_CAP_MS
    const horizonExitAt = entrySample.timestamp + Math.min(horizonMs, HORIZON_CAP_MS)

    return resolveFilledCounterfactualTrade({
        ...base,
        direction,
        entryPx,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
        samples: normalizePriceSamples(args.priceSeries.samples),
        startAt: entrySample.timestamp,
        horizonExitAt,
        conservativeFlag: false,
    })
}

export function resolveFilledCounterfactualTrade(args: {
    runId: string
    book: string
    kind: CounterfactualKind
    direction: CounterfactualDirection
    entryPx: number
    stopLoss: number
    takeProfit: number
    samples: CounterfactualPriceSample[]
    startAt: number
    horizonExitAt: number
    granularity: string
    conservativeFlag: boolean
    instrument?: string
    orderId?: string
    reason?: string
}): CounterfactualResolutionRow {
    const base: CounterfactualResolutionRow = {
        runId: args.runId,
        book: args.book,
        kind: args.kind,
        direction: args.direction,
        entryPx: args.entryPx,
        granularity: args.granularity,
        conservativeFlag: args.conservativeFlag,
        instrument: args.instrument,
        orderId: args.orderId,
        resolution: "unresolvable",
        reason: args.reason,
    }

    if (!hasValidTradeLevels(args.direction, args.entryPx, args.stopLoss, args.takeProfit)) {
        return markUnresolvable(base, "SL/TP levels are missing or not on the correct side of entry")
    }

    const samples = normalizePriceSamples(args.samples)
        .filter((sample) => sample.timestamp > args.startAt && sample.timestamp <= args.horizonExitAt)

    for (const sample of samples) {
        const hit = resolveStopTakeHit(args.direction, sample, args.stopLoss, args.takeProfit)
        if (hit === "ambiguous") {
            return buildResolvedTradeRow({
                ...base,
                direction: args.direction,
                entryPx: args.entryPx,
                exitPx: args.stopLoss,
                stopLoss: args.stopLoss,
                resolution: "sl",
                conservativeFlag: true,
                resolvedAt: sample.timestamp,
            })
        }
        if (hit === "sl") {
            return buildResolvedTradeRow({
                ...base,
                direction: args.direction,
                entryPx: args.entryPx,
                exitPx: args.stopLoss,
                stopLoss: args.stopLoss,
                resolution: "sl",
                resolvedAt: sample.timestamp,
            })
        }
        if (hit === "tp") {
            return buildResolvedTradeRow({
                ...base,
                direction: args.direction,
                entryPx: args.entryPx,
                exitPx: args.takeProfit,
                stopLoss: args.stopLoss,
                resolution: "tp",
                resolvedAt: sample.timestamp,
            })
        }
    }

    const horizonSample = findLastPriceSample(samples, args.horizonExitAt)
    if (!horizonSample) {
        return markUnresolvable(base, "no sampled price after entry before horizon")
    }

    return buildResolvedTradeRow({
        ...base,
        direction: args.direction,
        entryPx: args.entryPx,
        exitPx: resolveExitPriceFromSample(horizonSample, args.direction),
        stopLoss: args.stopLoss,
        resolution: "horizon_exit",
        resolvedAt: horizonSample.timestamp,
    })
}

export function parseForecastLevels(args: {
    forecast: DecisionRecord["forecast"]
    direction: CounterfactualDirection
    entryPx: number
}): ForecastLevels | undefined {
    const stopLoss = parseStopLossLevel(args.forecast?.invalidation, args.direction, args.entryPx)
    const takeProfit = parseTakeProfitLevel(args.forecast?.expectedMove, args.direction, args.entryPx)

    if (!hasValidTradeLevels(args.direction, args.entryPx, stopLoss, takeProfit)) {
        return undefined
    }

    return {
        stopLoss: stopLoss!,
        takeProfit: takeProfit!,
    }
}

export function parseForecastHorizonMs(value: string | undefined, referenceAt: number): number | undefined {
    if (!value) {
        return undefined
    }

    const durationMatch = value.match(/(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/iu)
    if (durationMatch?.[1] && durationMatch[2]) {
        const amount = Number(durationMatch[1])
        if (!Number.isFinite(amount) || amount <= 0) {
            return undefined
        }

        const unit = durationMatch[2].toLowerCase()
        if (unit === "m" || unit.startsWith("min")) {
            return amount * MINUTE_MS
        }
        if (unit === "h" || unit === "hr" || unit === "hrs" || unit.startsWith("hour")) {
            return amount * HOUR_MS
        }
        if (unit === "d" || unit.startsWith("day")) {
            return amount * DAY_MS
        }
    }

    const utcTimeMatch = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*UTC\b/iu)
    if (!utcTimeMatch?.[1] || !utcTimeMatch[2]) {
        return undefined
    }

    const reference = new Date(referenceAt)
    const target = Date.UTC(
        reference.getUTCFullYear(),
        reference.getUTCMonth(),
        reference.getUTCDate(),
        Number(utcTimeMatch[1]),
        Number(utcTimeMatch[2])
    )
    const adjustedTarget = target > referenceAt ? target : target + DAY_MS

    return adjustedTarget - referenceAt
}

export function summarizeCounterfactualRows(rows: CounterfactualResolutionRow[]): BookSummaryRow[] {
    const byBook = new Map<string, CounterfactualResolutionRow[]>()
    for (const row of rows) {
        byBook.set(row.book, [...(byBook.get(row.book) ?? []), row])
    }

    return Array.from(byBook.entries())
        .map(([book, bookRows]) => {
            const takenRows = bookRows.filter((row) => row.kind === "taken")
            const takenR = finiteValues(takenRows.map((row) => row.rMultiple))
            const unfilledRows = bookRows.filter((row) => row.kind === "unfilled")
            const declinedRows = bookRows.filter((row) => row.kind === "declined")

            return {
                book,
                takenCount: takenRows.length,
                takenAvgR: average(takenR),
                unfilledCount: unfilledRows.length,
                unfilledMissedR: sum(finiteValues(unfilledRows.map((row) => row.rMultiple))),
                declinedCount: declinedRows.length,
                declinedForegoneR: sum(finiteValues(declinedRows.map((row) => row.rMultiple))),
                conservativeFlagCount: bookRows.filter((row) => row.conservativeFlag).length,
                unresolvableCount: bookRows.filter((row) => row.resolution === "unresolvable").length,
            }
        })
        .sort((left, right) => left.book.localeCompare(right.book))
}

export function renderCounterfactualSummaryMarkdown(summary: BookSummaryRow[]): string {
    const lines = [
        "| Book | Taken n/avgR | Unfilled n/missedR | Declined n/foregoneR | Conservative | Unresolvable |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]

    for (const row of summary) {
        lines.push([
            `| ${escapeMarkdownCell(row.book)}`,
            `${row.takenCount}/${formatOptionalNumber(row.takenAvgR)}`,
            `${row.unfilledCount}/${formatNumber(row.unfilledMissedR)}`,
            `${row.declinedCount}/${formatNumber(row.declinedForegoneR)}`,
            String(row.conservativeFlagCount),
            `${row.unresolvableCount} |`,
        ].join(" | "))
    }

    return `${lines.join("\n")}\n`
}

export function resolveDirectionFromIntent(intent: Pick<OrderIntent, "side">): CounterfactualDirection {
    return intent.side === "buy" ? "long" : "short"
}

export function resolveProposedEntryPrice(intent: OrderIntent): number | undefined {
    return readFiniteNumber(intent.limitPrice) ??
        readFiniteNumber(intent.stopPrice) ??
        readFiniteNumber(intent.metadata?.estimatedPrice)
}

export function readIntentStopLoss(intent: OrderIntent): number | undefined {
    return readFiniteNumber(intent.metadata?.stopLoss)
}

export function readIntentTakeProfit(intent: OrderIntent): number | undefined {
    return readFiniteNumber(intent.metadata?.takeProfit)
}

export function readFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
            return parsed
        }
    }

    return undefined
}

export function computeRMultiple(args: {
    direction: CounterfactualDirection
    entryPx: number
    exitPx: number
    stopLoss: number
}): number | undefined {
    if (!hasFiniteNumbers(args.entryPx, args.exitPx, args.stopLoss)) {
        return undefined
    }

    const risk = Math.abs(args.entryPx - args.stopLoss)
    if (risk <= 0) {
        return undefined
    }

    const signedMove = args.direction === "long"
        ? args.exitPx - args.entryPx
        : args.entryPx - args.exitPx

    return signedMove / risk
}

export function computeDirectionalPercent(args: {
    direction: CounterfactualDirection
    entryPx: number
    exitPx: number
}): number | undefined {
    if (!isFinitePositive(args.entryPx) || !Number.isFinite(args.exitPx)) {
        return undefined
    }

    const signedMove = args.direction === "long"
        ? args.exitPx - args.entryPx
        : args.entryPx - args.exitPx

    return (signedMove / args.entryPx) * 100
}

function buildBaseRow(args: {
    runId: string
    book: string
    kind: CounterfactualKind
    direction?: CounterfactualDirection
    priceSeries: CounterfactualPriceSeries
    instrument?: string
    orderId?: string
}): CounterfactualResolutionRow {
    return {
        runId: args.runId,
        book: args.book,
        kind: args.kind,
        direction: args.direction,
        instrument: args.instrument,
        orderId: args.orderId,
        resolution: "unresolvable",
        granularity: args.priceSeries.granularity,
        conservativeFlag: false,
    }
}

function markUnresolvable(row: CounterfactualResolutionRow, reason: string): CounterfactualResolutionRow {
    return {
        ...row,
        resolution: "unresolvable",
        reason,
    }
}

function findEntryFill(args: {
    samples: CounterfactualPriceSample[]
    direction: CounterfactualDirection
    orderType?: OrderIntent["orderType"]
    entryPx: number
    afterAt: number
    deadlineAt: number
}): CounterfactualPriceSample | undefined {
    return args.samples.find((sample) => {
        if (sample.timestamp <= args.afterAt || sample.timestamp > args.deadlineAt) {
            return false
        }

        if (args.orderType === "market") {
            return true
        }

        if (args.orderType === "limit") {
            return args.direction === "long"
                ? sample.low <= args.entryPx
                : sample.high >= args.entryPx
        }

        if (args.orderType === "stop" || args.orderType === "stop_limit") {
            return args.direction === "long"
                ? sample.high >= args.entryPx
                : sample.low <= args.entryPx
        }

        return sample.low <= args.entryPx && sample.high >= args.entryPx
    })
}

function resolveStopTakeHit(
    direction: CounterfactualDirection,
    sample: CounterfactualPriceSample,
    stopLoss: number,
    takeProfit: number
): "sl" | "tp" | "ambiguous" | undefined {
    const stopHit = direction === "long"
        ? sample.low <= stopLoss
        : sample.high >= stopLoss
    const takeProfitHit = direction === "long"
        ? sample.high >= takeProfit
        : sample.low <= takeProfit

    if (stopHit && takeProfitHit) {
        return "ambiguous"
    }
    if (stopHit) {
        return "sl"
    }
    if (takeProfitHit) {
        return "tp"
    }

    return undefined
}

function buildResolvedTradeRow(row: Omit<CounterfactualResolutionRow, "resolvedAt"> & {
    direction: CounterfactualDirection
    entryPx: number
    exitPx: number | undefined
    stopLoss: number
    resolvedAt: number
}): CounterfactualResolutionRow {
    const rMultiple = row.exitPx === undefined
        ? undefined
        : computeRMultiple({
            direction: row.direction,
            entryPx: row.entryPx,
            exitPx: row.exitPx,
            stopLoss: row.stopLoss,
        })
    const percent = row.exitPx === undefined
        ? undefined
        : computeDirectionalPercent({
            direction: row.direction,
            entryPx: row.entryPx,
            exitPx: row.exitPx,
        })

    const { stopLoss, ...publicRow } = row

    return {
        ...publicRow,
        rMultiple,
        percent,
        resolvedAt: new Date(row.resolvedAt).toISOString(),
    }
}

function findNextPriceSample(
    samples: CounterfactualPriceSample[],
    afterAt: number
): CounterfactualPriceSample | undefined {
    return normalizePriceSamples(samples).find((sample) => sample.timestamp > afterAt)
}

function findLastPriceSample(
    samples: CounterfactualPriceSample[],
    atOrBefore: number
): CounterfactualPriceSample | undefined {
    let match: CounterfactualPriceSample | undefined
    for (const sample of samples) {
        if (sample.timestamp <= atOrBefore) {
            match = sample
        }
    }

    return match
}

function resolveEntryPriceFromSample(
    sample: CounterfactualPriceSample,
    direction: CounterfactualDirection
): number {
    if (direction === "long") {
        return sample.ask ?? sample.open ?? sample.close
    }

    return sample.bid ?? sample.open ?? sample.close
}

function resolveExitPriceFromSample(
    sample: CounterfactualPriceSample,
    direction: CounterfactualDirection
): number {
    if (direction === "long") {
        return sample.bid ?? sample.close
    }

    return sample.ask ?? sample.close
}

function resolveSampleMidpoint(sample: CounterfactualPriceSample): number {
    if (sample.bid !== undefined && sample.ask !== undefined) {
        return (sample.bid + sample.ask) / 2
    }

    return sample.close
}

function parseStopLossLevel(
    value: string | undefined,
    direction: CounterfactualDirection,
    entryPx: number
): number | undefined {
    if (!value) {
        return undefined
    }

    const explicit = parseExplicitStopCandidates(value)
        .filter((candidate) => isStopSide(candidate, direction, entryPx))
    if (explicit.length > 0) {
        return chooseFurthestCandidate(explicit, entryPx)
    }

    const candidates = parseAbsolutePriceCandidates(value)
        .filter((candidate) => isStopSide(candidate, direction, entryPx))

    return chooseClosestCandidate(candidates, entryPx)
}

function parseTakeProfitLevel(
    value: string | undefined,
    direction: CounterfactualDirection,
    entryPx: number
): number | undefined {
    if (!value) {
        return undefined
    }

    const candidates = parseAbsolutePriceCandidates(value)
        .filter((candidate) => isTakeProfitSide(candidate, direction, entryPx))
    if (candidates.length > 0) {
        return chooseClosestCandidate(candidates, entryPx)
    }

    const percent = parseExpectedMovePercent(value)
    if (percent === undefined) {
        return undefined
    }

    const signedPercent = Math.abs(percent) / 100
    return direction === "long"
        ? entryPx * (1 + signedPercent)
        : entryPx * (1 - signedPercent)
}

function parseExplicitStopCandidates(value: string): number[] {
    const candidates: number[] = []
    const pattern = /\b(?:SL|stop(?:\s|-)?loss|stop)\s*(?:at|=|:|near|around|above|below)?\s*([+-]?\d+(?:\.\d+)?)/giu
    let match = pattern.exec(value)

    while (match) {
        const candidate = readFiniteNumber(match[1])
        if (candidate !== undefined) {
            candidates.push(candidate)
        }
        match = pattern.exec(value)
    }

    return candidates
}

function parseAbsolutePriceCandidates(value: string): number[] {
    const candidates: number[] = []
    const pattern = /(?<![A-Za-z])([+-]?\d+(?:\.\d+)?)(?!\s*%)(?![A-Za-z])/gu
    let match = pattern.exec(value)

    while (match) {
        const candidate = readFiniteNumber(match[1])
        if (candidate !== undefined && candidate > 0) {
            candidates.push(candidate)
        }
        match = pattern.exec(value)
    }

    return candidates
}

function parseExpectedMovePercent(value: string): number | undefined {
    const match = value.match(/([+-]?\d+(?:\.\d+)?)\s*%/u)
    if (!match?.[1]) {
        return undefined
    }

    const parsed = Number(match[1])
    return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined
}

function isStopSide(value: number, direction: CounterfactualDirection, entryPx: number): boolean {
    return direction === "long"
        ? value < entryPx
        : value > entryPx
}

function isTakeProfitSide(value: number, direction: CounterfactualDirection, entryPx: number): boolean {
    return direction === "long"
        ? value > entryPx
        : value < entryPx
}

function chooseClosestCandidate(values: number[], entryPx: number): number | undefined {
    return [...values].sort((left, right) => Math.abs(left - entryPx) - Math.abs(right - entryPx))[0]
}

function chooseFurthestCandidate(values: number[], entryPx: number): number | undefined {
    return [...values].sort((left, right) => Math.abs(right - entryPx) - Math.abs(left - entryPx))[0]
}

function hasValidTradeLevels(
    direction: CounterfactualDirection,
    entryPx: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined
): stopLoss is number {
    if (!isFinitePositive(entryPx) || !isFinitePositive(stopLoss) || !isFinitePositive(takeProfit)) {
        return false
    }

    return direction === "long"
        ? stopLoss < entryPx && takeProfit > entryPx
        : stopLoss > entryPx && takeProfit < entryPx
}

function isFinitePositive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
}

function hasFiniteNumbers(...values: number[]): boolean {
    return values.every((value) => Number.isFinite(value))
}

function finiteValues(values: Array<number | undefined>): number[] {
    return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
}

function average(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined
    }

    return sum(values) / values.length
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0)
}

function formatOptionalNumber(value: number | undefined): string {
    return value === undefined ? "n/a" : formatNumber(value)
}

function formatNumber(value: number): string {
    return value.toFixed(2)
}

function escapeMarkdownCell(value: string): string {
    return value.replace(/\|/gu, "\\|")
}

function resolveEarliestTimestamp(samples: CounterfactualPriceSample[]): number | undefined {
    const [first] = samples
    return first?.timestamp
}

function parseOKXCandleRow(row: unknown): CounterfactualPriceSample | undefined {
    if (!Array.isArray(row) || row.length < 5) {
        return undefined
    }

    const timestamp = readFiniteNumber(row[0])
    const open = readFiniteNumber(row[1])
    const high = readFiniteNumber(row[2])
    const low = readFiniteNumber(row[3])
    const close = readFiniteNumber(row[4])

    if (
        timestamp === undefined ||
        open === undefined ||
        high === undefined ||
        low === undefined ||
        close === undefined
    ) {
        return undefined
    }

    return {
        timestamp,
        open,
        high,
        low,
        close,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
