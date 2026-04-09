export interface PolymarketPriceProvider {
    getPrice(tokenId: string, side: "buy" | "sell"): Promise<number>;
}
export declare function resolveEstimatedPrice(venue: PolymarketPriceProvider, tokenId: string, side: "buy" | "sell", limitPrice?: number): Promise<number>;
//# sourceMappingURL=polymarket-order-helpers.d.ts.map