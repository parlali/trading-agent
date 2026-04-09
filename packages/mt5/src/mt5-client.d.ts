/**
 * MT5 HTTP client -- communicates with the Python worker over HTTP.
 *
 * The Python worker wraps the MT5 SDK. This client proxies the VenueAdapter
 * interface calls to the worker's REST endpoints.
 */
import { type ExecutionResult } from "@valiq-trading/core";
export interface MT5WorkerCredentials {
    login: number;
    password: string;
    server: string;
}
export interface MT5ClientConfig {
    /** Base URL of the Python worker (e.g. http://192.168.1.100:8090) */
    workerUrl: string;
    /** Shared access key for auth */
    accessKey?: string;
    /** Request timeout in ms */
    timeout?: number;
}
export interface MT5AccountInfo {
    login: number;
    name: string;
    server: string;
    company: string;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    marginLevel: number;
    currency: string;
    leverage: number;
    profit: number;
}
export interface MT5Position {
    ticket: number;
    symbol: string;
    type: "buy" | "sell";
    volume: number;
    openPrice: number;
    currentPrice: number;
    stopLoss: number;
    takeProfit: number;
    profit: number;
    swap: number;
    commission: number;
    magic: number;
    comment: string;
    openTime: number;
    identifier: number;
}
export interface MT5OpenOrder {
    ticket: number;
    symbol: string;
    type: string;
    volumeInitial: number;
    volumeCurrent: number;
    priceOpen: number;
    stopLoss: number;
    takeProfit: number;
    state: string;
    comment: string;
    magic: number;
    timeSetup: number;
    timeDone: number;
}
export interface MT5OrderResult {
    retcode: number;
    retcodeDescription: string;
    retcodeExternal?: number;
    orderId: string;
    dealId?: string;
    volume: number;
    price: number;
    comment?: string;
    bid?: number;
    ask?: number;
    success: boolean;
}
export interface MT5SymbolInfo {
    symbol: string;
    digits: number;
    point: number;
    pipSize: number;
    tickValue: number;
    contractSize: number;
    currency: string;
    description: string;
    spread: number;
    volumeMin: number;
    volumeMax: number;
    volumeStep: number;
    fillingMode: number;
    bid: number;
    ask: number;
}
export declare class MT5Client {
    private readonly workerUrl;
    private readonly accessKey;
    private readonly timeout;
    private connected;
    constructor(config: MT5ClientConfig);
    connect(credentials: MT5WorkerCredentials): Promise<MT5AccountInfo>;
    disconnect(): Promise<void>;
    getHealth(): Promise<{
        status: string;
        connected: boolean;
        login: number | null;
    }>;
    getAccount(): Promise<MT5AccountInfo>;
    getPositions(): Promise<MT5Position[]>;
    getOpenOrders(): Promise<MT5OpenOrder[]>;
    submitOrder(params: {
        symbol: string;
        side: string;
        volume: number;
        orderType?: string;
        price?: number;
        stopLoss?: number;
        takeProfit?: number;
        magic?: number;
        comment?: string;
        deviation?: number;
    }): Promise<MT5OrderResult>;
    modifyPosition(params: {
        ticket: number;
        stopLoss?: number;
        takeProfit?: number;
    }): Promise<MT5OrderResult>;
    cancelOrder(params: {
        ticket: number;
    }): Promise<MT5OrderResult>;
    closePosition(params: {
        ticket: number;
        volume?: number;
        deviation?: number;
    }): Promise<MT5OrderResult>;
    closeAllPositions(): Promise<{
        closed: number;
        results: MT5OrderResult[];
    }>;
    getSymbolInfo(symbols: string[]): Promise<MT5SymbolInfo[]>;
    getOrderStatus(orderId: number): Promise<{
        ticket: number;
        symbol: string;
        type: string;
        volume: number;
        price: number;
        state: string;
    } | null>;
    mapOrderResultToExecution(result: MT5OrderResult, options?: {
        fallbackOrderId?: string;
        successStatus?: ExecutionResult["status"];
        filledQuantity?: number;
        fillPrice?: number;
    }): ExecutionResult;
    private get;
    private post;
    private headers;
}
//# sourceMappingURL=mt5-client.d.ts.map