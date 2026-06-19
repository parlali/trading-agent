import {
    formatExecutionCostAssessment,
    type MT5Policy,
    type ExecutionCostAssessment,
} from "@valiq-trading/core"
import type { MT5SymbolInfo } from "./mt5-client"
import {
    normalizeMT5Symbol,
    resolveMT5AllowedSymbols,
} from "./symbols"

type SpreadUnit = "pips" | "points"

const DEFAULT_INSTRUMENT_PROFILES: Record<string, {
    regions: string[]
    spreadUnit: SpreadUnit
}> = {
    EURUSD: {
        regions: ["US", "GB", "EU"],
        spreadUnit: "pips",
    },
    USDJPY: {
        regions: ["US", "GB", "EU"],
        spreadUnit: "pips",
    },
    XAUUSD: {
        regions: ["US", "GB"],
        spreadUnit: "points",
    },
    US30: {
        regions: ["US"],
        spreadUnit: "points",
    },
}

const DEFAULT_STRATEGY_INSTRUMENTS: Record<string, string[]> = {
    "00:00|22:00|UTC": ["EURUSD", "USDJPY"],
    "07:00|21:00|UTC": ["XAUUSD"],
    "13:00|21:00|UTC": ["US30"],
}

export interface MT5MarketSnapshot {
    instrument: string
    bid: number
    ask: number
    spread: number
    spreadUnit: SpreadUnit
    executionCost: ExecutionCostAssessment
}

export interface MT5NormalizedSpread {
    value: number
    unit: SpreadUnit
}

export function resolveMT5InstrumentRegions(policy: MT5Policy): Record<string, string[]> {
    const configured = normalizeConfiguredInstrumentRegions(policy.marketRegionsByInstrument)
    if (Object.keys(configured).length > 0) {
        return configured
    }

    const fallbackInstruments = resolveFallbackInstruments(policy)
    const fallbackRegions = fallbackInstruments.flatMap((instrument) => {
        const profile = DEFAULT_INSTRUMENT_PROFILES[instrument]
        if (!profile) {
            return []
        }

        return [[instrument, profile.regions] as const]
    })

    return Object.fromEntries(fallbackRegions)
}

export function createMT5SpreadContextLine(
    snapshots: readonly MT5MarketSnapshot[]
): string | null {
    if (snapshots.length === 0) {
        return null
    }

    const parts = [...snapshots]
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((snapshot) => formatExecutionCostAssessment(snapshot.executionCost))

    return `Current MT5 execution context: ${parts.join(" | ")}`
}

export function toMT5MarketSnapshot(
    symbolInfo: MT5SymbolInfo,
    executionCost: ExecutionCostAssessment
): MT5MarketSnapshot {
    const spread = resolveMT5NormalizedSpread(symbolInfo)
    return {
        instrument: symbolInfo.symbol.trim(),
        bid: symbolInfo.bid,
        ask: symbolInfo.ask,
        spread: spread.value,
        spreadUnit: spread.unit,
        executionCost,
    }
}

function normalizeConfiguredInstrumentRegions(
    configured: MT5Policy["marketRegionsByInstrument"]
): Record<string, string[]> {
    if (!configured) {
        return {}
    }

    const entries = Object.entries(configured).flatMap(([instrument, regions]) => {
        const configuredInstrument = instrument.trim()
        const normalizedRegions = [...new Set(
            regions
                .map((region) => region.trim().toUpperCase())
                .filter((region) => region.length > 0)
        )]

        if (!configuredInstrument || normalizedRegions.length === 0) {
            return []
        }

        return [[configuredInstrument, normalizedRegions] as const]
    })

    const configuredSymbols = resolveMT5AllowedSymbols(entries.map(([instrument]) => instrument))
    const regionsByNormalizedSymbol = new Map(
        entries.map(([instrument, regions]) => [normalizeMT5Symbol(instrument), regions])
    )

    return Object.fromEntries(configuredSymbols.map((symbol) => [
        symbol,
        regionsByNormalizedSymbol.get(normalizeMT5Symbol(symbol)) ?? [],
    ]))
}

function resolveFallbackInstruments(policy: MT5Policy): string[] {
    const key = [
        policy.tradingHours.start,
        policy.tradingHours.end,
        policy.tradingHours.timezone.toUpperCase(),
    ].join("|")

    return DEFAULT_STRATEGY_INSTRUMENTS[key] ?? []
}

function normalizeInstrument(instrument: string): string {
    return normalizeMT5Symbol(instrument)
}

export function resolveMT5NormalizedSpread(symbolInfo: MT5SymbolInfo): MT5NormalizedSpread {
    const profile = DEFAULT_INSTRUMENT_PROFILES[normalizeInstrument(symbolInfo.symbol)]
    const unit = profile?.spreadUnit ?? "points"
    const unitSize = unit === "pips"
        ? symbolInfo.pipSize
        : symbolInfo.point
    const value = resolveSpreadValue(symbolInfo, unitSize)

    return {
        value,
        unit,
    }
}

function resolveSpreadValue(symbolInfo: MT5SymbolInfo, unitSize: number): number {
    const priceSpread = Math.abs(symbolInfo.ask - symbolInfo.bid)
    if (unitSize > 0 && priceSpread > 0) {
        return priceSpread / unitSize
    }

    if (symbolInfo.point > 0 && unitSize > 0 && symbolInfo.spread > 0) {
        return (symbolInfo.spread * symbolInfo.point) / unitSize
    }

    return symbolInfo.spread
}
