import { type ExecutionErrorDetail } from "@valiq-trading/core";
export interface PolymarketCredentials {
    /** Hex-encoded private key for the trading wallet (with or without 0x prefix) */
    privateKey: string;
    /** L2 HMAC API key */
    apiKey: string;
    /** L2 HMAC API secret (base64-encoded) */
    apiSecret: string;
    /** L2 HMAC API passphrase */
    apiPassphrase: string;
    /** CLOB API host. Defaults to https://clob.polymarket.com */
    host?: string;
    /** Chain ID. 137 for Polygon mainnet, 80002 for Amoy testnet */
    chainId?: number;
    /** Polymarket profile or funder address for proxy wallet (type 1) */
    funderAddress: string;
}
export type PolymarketSignatureType = 1;
export interface PolymarketMarket {
    conditionId: string;
    questionId: string;
    question: string;
    description: string;
    category: string;
    tokens: PolymarketToken[];
    active: boolean;
    closed: boolean;
    negRisk: boolean;
    minimumOrderSize: number;
    minimumTickSize: number;
    volume?: number;
    liquidity?: number;
    endDateIso: string;
    marketSlug: string;
}
export interface PolymarketToken {
    tokenId: string;
    outcome: string;
}
export interface PolymarketOrderBook {
    market: string;
    assetId: string;
    bids: Array<{
        price: string;
        size: string;
    }>;
    asks: Array<{
        price: string;
        size: string;
    }>;
    hash: string;
    timestamp: string;
}
export interface PostOrderResponse {
    success: boolean;
    errorMsg: string;
    orderID: string;
    transactionsHashes: string[];
    status: string;
}
export interface PolymarketOpenOrder {
    id: string;
    status: string;
    owner: string;
    market: string;
    asset_id: string;
    side: string;
    original_size: string;
    size_matched: string;
    price: string;
    outcome: string;
    order_type: string;
    created_at: string;
    expiration: string;
}
export interface PolymarketTrade {
    id: string;
    taker_order_id: string;
    market: string;
    asset_id: string;
    side: string;
    size: string;
    price: string;
    fee_rate_bps: string;
    status: string;
    match_time: string;
    outcome: string;
    trader_side: string;
}
export interface PolymarketBalanceAllowance {
    balance: string;
    allowances?: Record<string, string>;
}
export interface CreateOrderParams {
    tokenId: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    orderType: "GTC" | "GTD" | "FOK" | "FAK";
    expiration?: number;
    negRisk?: boolean;
}
interface PaginatedResponse<T> {
    data: T[];
    next_cursor: string;
    limit: number;
    count: number;
}
export declare class PolymarketApiError extends Error {
    readonly status: number;
    readonly retryable: boolean;
    readonly executionError: ExecutionErrorDetail;
    constructor(message: string, status: number, options?: {
        code?: string;
        retryable?: boolean;
        details?: Record<string, unknown>;
    });
}
export declare class PolymarketClient {
    private readonly account;
    private readonly address;
    private readonly apiKey;
    private readonly apiSecret;
    private readonly apiPassphrase;
    private readonly host;
    private readonly chainId;
    private readonly signatureType;
    private readonly funderAddress;
    private tickSizeCache;
    private negRiskCache;
    private feeRateCache;
    private readonly CACHE_TTL_MS;
    constructor(credentials: PolymarketCredentials);
    getAddress(): string;
    getFunderAddress(): string;
    getSignatureType(): PolymarketSignatureType;
    getMarkets(params?: {
        nextCursor?: string;
        limit?: number;
        active?: boolean;
    }): Promise<PaginatedResponse<PolymarketMarket>>;
    getAllActiveMarkets(): Promise<PolymarketMarket[]>;
    getMarket(conditionId: string): Promise<PolymarketMarket>;
    getOrderBook(tokenId: string): Promise<PolymarketOrderBook>;
    getMidpoint(tokenId: string): Promise<number>;
    getPrice(tokenId: string, side: "buy" | "sell"): Promise<number>;
    getSpread(tokenId: string): Promise<{
        bid: number;
        ask: number;
        spread: number;
    }>;
    getTickSize(tokenId: string): Promise<string>;
    getNegRisk(tokenId: string): Promise<boolean>;
    getFeeRateBps(tokenId: string): Promise<number>;
    createOrder(params: CreateOrderParams): Promise<PostOrderResponse>;
    getOrder(orderId: string): Promise<PolymarketOpenOrder>;
    getOpenOrders(params?: {
        market?: string;
        assetId?: string;
    }): Promise<PolymarketOpenOrder[]>;
    cancelOrder(orderId: string): Promise<void>;
    cancelOrders(orderIds: string[]): Promise<void>;
    cancelAll(): Promise<void>;
    getTrades(params?: {
        market?: string;
        assetId?: string;
        before?: string;
        after?: string;
    }): Promise<PolymarketTrade[]>;
    /** Get USDC balance (converted from raw 6-decimal integer to USD) */
    getBalance(): Promise<number>;
    /** Get conditional token balance for a specific token (converted from raw 6-decimal integer) */
    getTokenBalance(tokenId: string): Promise<number>;
    getBalanceAllowance(params: {
        assetType: "COLLATERAL" | "CONDITIONAL";
        tokenId?: string;
    }): Promise<PolymarketBalanceAllowance | undefined>;
    private requestPublic;
    private requestAuthenticated;
    private buildL2Headers;
}
export {};
//# sourceMappingURL=polymarket-client.d.ts.map