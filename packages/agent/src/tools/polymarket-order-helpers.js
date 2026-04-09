export async function resolveEstimatedPrice(venue, tokenId, side, limitPrice) {
    if (limitPrice !== undefined && limitPrice > 0) {
        return limitPrice;
    }
    const currentPrice = await venue.getPrice(tokenId, side);
    return side === "buy"
        ? Math.min(currentPrice * 1.02, 0.99)
        : Math.max(currentPrice * 0.98, 0.01);
}
