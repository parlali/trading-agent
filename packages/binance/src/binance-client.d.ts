import { type ExecutionErrorDetail } from "@valiq-trading/core";
export interface BinanceCredentials {
    apiKey: string;
    apiSecret: string;
    baseUrl?: string;
    recvWindow?: number;
}
export interface BinanceAccountInfo {
    availableBalance: string;
    totalWalletBalance: string;
    totalUnrealizedProfit: string;
    totalInitialMargin: string;
    totalMaintMargin: string;
}
export interface BinancePositionRisk {
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unRealizedProfit: string;
    liquidationPrice: string;
    leverage: string;
    marginType: string;
}
export interface BinanceExchangeInfo {
    timezone: string;
    symbols: BinanceExchangeSymbol[];
}
export interface BinanceExchangeSymbol {
    symbol: string;
    status: string;
    pricePrecision: number;
    quantityPrecision: number;
    filters: Array<Record<string, string>>;
}
export interface BinanceOrderResponse {
    symbol: string;
    orderId: number;
    status: string;
    type: string;
    side: "BUY" | "SELL";
    price: string;
    avgPrice: string;
    origQty: string;
    executedQty: string;
    stopPrice: string;
    reduceOnly: boolean;
    updateTime?: number;
    time?: number;
}
export interface BinanceBookTicker {
    symbol: string;
    bidPrice: string;
    askPrice: string;
}
export interface BinancePremiumIndex {
    symbol: string;
    markPrice: string;
    indexPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
    time: number;
}
export interface BinanceOrderBookDepth {
    lastUpdateId: number;
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
    E?: number;
    T?: number;
}
export interface BinanceFundingRate {
    symbol: string;
    fundingRate: string;
    fundingTime: number;
    markPrice: string;
}
export interface BinanceCreateOrderParams {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT" | "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET";
    quantity?: number;
    price?: number;
    stopPrice?: number;
    timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
    reduceOnly?: boolean;
    closePosition?: boolean;
    workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
}
export declare class BinanceApiError extends Error {
    readonly status: number;
    readonly code?: number;
    readonly retryable: boolean;
    readonly executionError: ExecutionErrorDetail;
    constructor(message: string, status: number, code?: number);
}
export declare class BinanceClient {
    private readonly apiKey;
    private readonly apiSecret;
    private readonly baseUrl;
    private readonly recvWindow;
    private usedWeight1m;
    constructor(credentials: BinanceCredentials);
    getBaseUrl(): string;
    getUsedWeight1m(): number | null;
    ping(): Promise<void>;
    getExchangeInfo(): Promise<BinanceExchangeInfo>;
    getAccount(): Promise<BinanceAccountInfo>;
    getPositionRisk(symbol?: string): Promise<BinancePositionRisk[]>;
    getOrder(symbol: string, orderId: number): Promise<BinanceOrderResponse>;
    getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]>;
    createOrder(params: BinanceCreateOrderParams): Promise<BinanceOrderResponse>;
    cancelOrder(symbol: string, orderId: number): Promise<BinanceOrderResponse>;
    setLeverage(symbol: string, leverage: number): Promise<{
        leverage: number;
    }>;
    setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<void>;
    setPositionMode(dualSidePosition: boolean): Promise<void>;
    getBookTicker(symbol: string): Promise<BinanceBookTicker>;
    getPremiumIndex(symbol: string): Promise<BinancePremiumIndex>;
    getFundingRates(symbol: string, limit?: number): Promise<BinanceFundingRate[]>;
    getDepth(symbol: string, limit?: number): Promise<BinanceOrderBookDepth>;
    private publicRequest;
    private signedRequest;
    private captureRateLimitHeaders;
    private sign;
}
//# sourceMappingURL=binance-client.d.ts.map