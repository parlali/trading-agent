import { resolvePolymarketExecutablePrice } from "@valiq-trading/polymarket"

export interface PolymarketPriceProvider {
    getPrice(tokenId: string, side: "buy" | "sell"): Promise<number>
}

export async function resolveEstimatedPrice(
    venue: PolymarketPriceProvider,
    tokenId: string,
    side: "buy" | "sell",
    limitPrice?: number
): Promise<number> {
    if (limitPrice !== undefined && limitPrice > 0) {
        return limitPrice
    }

    const currentPrice = await venue.getPrice(tokenId, side)
    return resolvePolymarketExecutablePrice(side, currentPrice)
}
