import type { MT5Policy } from "@valiq-trading/core"

export function normalizeMT5Symbol(symbol: string): string {
    return symbol.trim().toUpperCase()
}

export function resolveMT5ConfiguredSymbols(policy: MT5Policy): string[] {
    return resolveMT5AllowedSymbols(Object.keys(policy.marketRegionsByInstrument ?? {}))
}

export function resolveMT5AllowedSymbols(symbols: readonly string[]): string[] {
    const byNormalizedSymbol = new Map<string, string>()

    for (const symbol of symbols) {
        const configuredSymbol = symbol.trim()
        if (configuredSymbol.length === 0) {
            continue
        }

        const normalizedSymbol = normalizeMT5Symbol(configuredSymbol)
        const existing = byNormalizedSymbol.get(normalizedSymbol)
        if (existing && existing !== configuredSymbol) {
            throw new Error(`MT5 symbol configuration contains duplicate provider symbols after normalization: ${existing}, ${configuredSymbol}`)
        }

        byNormalizedSymbol.set(normalizedSymbol, configuredSymbol)
    }

    return Array.from(byNormalizedSymbol.values())
        .sort((left, right) => normalizeMT5Symbol(left).localeCompare(normalizeMT5Symbol(right)))
}

export function resolveMT5AllowedSymbol(
    symbol: string,
    allowedSymbols: readonly string[]
): string {
    const normalized = normalizeMT5Symbol(symbol)
    const allowed = resolveMT5AllowedSymbols(allowedSymbols)

    if (normalized.length === 0) {
        throw new Error("MT5 symbol is required")
    }

    if (allowed.length === 0) {
        throw new Error("MT5 strategy has no configured provider-verified symbols")
    }

    const configuredSymbol = allowed.find((allowedSymbol) =>
        normalizeMT5Symbol(allowedSymbol) === normalized
    )

    if (!configuredSymbol) {
        throw new Error(`MT5 symbol ${symbol.trim()} is outside the configured provider-verified symbol set: ${allowed.join(", ")}`)
    }

    return configuredSymbol
}
