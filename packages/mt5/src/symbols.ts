import type { MT5Policy } from "@valiq-trading/core"
export function normalizeMT5Symbol(symbol: string): string {
    return symbol.trim().toUpperCase()
}

export function resolveMT5ConfiguredSymbols(policy: MT5Policy): string[] {
    return Object.keys(policy.marketRegionsByInstrument ?? {})
        .map(normalizeMT5Symbol)
        .filter((symbol) => symbol.length > 0)
        .sort((left, right) => left.localeCompare(right))
}

export function resolveMT5AllowedSymbol(
    symbol: string,
    allowedSymbols: readonly string[]
): string {
    const normalized = normalizeMT5Symbol(symbol)
    const allowed = new Set(allowedSymbols.map(normalizeMT5Symbol))

    if (allowed.size === 0) {
        throw new Error("MT5 strategy has no configured provider-verified symbols")
    }

    if (!allowed.has(normalized)) {
        throw new Error(`MT5 symbol ${normalized} is outside the configured provider-verified symbol set: ${Array.from(allowed).sort().join(", ")}`)
    }

    return normalized
}
