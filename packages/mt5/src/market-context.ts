import type { MT5Policy } from "@valiq-trading/core"
import type { MT5SymbolInfo } from "./mt5-client"

type SpreadUnit = "pips" | "points"

const DEFAULT_INSTRUMENT_PROFILES: Record<string, {
    regions: string[]
    normalSpread: number
    spreadUnit: SpreadUnit
}> = {
    EURUSD: {
        regions: ["US", "GB", "EU"],
        normalSpread: 1.0,
        spreadUnit: "pips",
    },
    USDJPY: {
        regions: ["US", "GB", "EU"],
        normalSpread: 1.0,
        spreadUnit: "pips",
    },
    XAUUSD: {
        regions: ["US", "GB"],
        normalSpread: 25,
        spreadUnit: "points",
    },
    US30: {
        regions: ["US"],
        normalSpread: 20,
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
    normalSpread?: number
}

export interface MT5NormalizedSpread {
    value: number
    unit: SpreadUnit
    normal?: number
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
        .map((snapshot) => {
            const currentSpread = formatSpreadValue(snapshot.spread)

            if (snapshot.normalSpread === undefined) {
                return `${snapshot.instrument} ${currentSpread} ${snapshot.spreadUnit}`
            }

            return `${snapshot.instrument} ${currentSpread} ${snapshot.spreadUnit} (normal ~${formatSpreadValue(snapshot.normalSpread)})`
        })

    return `Current spreads: ${parts.join(", ")}`
}

export function toMT5MarketSnapshot(symbolInfo: MT5SymbolInfo): MT5MarketSnapshot {
    const spread = resolveMT5NormalizedSpread(symbolInfo)
    return {
        instrument: normalizeInstrument(symbolInfo.symbol),
        bid: symbolInfo.bid,
        ask: symbolInfo.ask,
        spread: spread.value,
        spreadUnit: spread.unit,
        normalSpread: spread.normal,
    }
}

function normalizeConfiguredInstrumentRegions(
    configured: MT5Policy["marketRegionsByInstrument"]
): Record<string, string[]> {
    if (!configured) {
        return {}
    }

    const entries = Object.entries(configured).flatMap(([instrument, regions]) => {
        const normalizedInstrument = normalizeInstrument(instrument)
        const normalizedRegions = [...new Set(
            regions
                .map((region) => region.trim().toUpperCase())
                .filter((region) => region.length > 0)
        )]

        if (!normalizedInstrument || normalizedRegions.length === 0) {
            return []
        }

        return [[normalizedInstrument, normalizedRegions] as const]
    })

    return Object.fromEntries(entries)
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
    return instrument.trim().toUpperCase()
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
        normal: profile?.normalSpread,
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

function formatSpreadValue(value: number): string {
    if (Math.abs(value) < 10) {
        return value.toFixed(1)
    }

    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
}
