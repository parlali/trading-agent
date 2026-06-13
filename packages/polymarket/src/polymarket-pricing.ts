export function resolvePolymarketExecutablePrice(
    side: "buy" | "sell",
    currentPrice: number
): number {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return currentPrice
    }

    const executablePrice = side === "buy"
        ? Math.min(currentPrice * 1.02, 0.99)
        : Math.max(currentPrice * 0.98, 0.01)
    return Math.round(executablePrice * 1_000_000) / 1_000_000
}
