import { createHmac } from "crypto"
import { createExecutionErrorDetail, fetchWithTimeout, retryWithBackoff, type ExecutionErrorDetail } from "@valiq-trading/core"

export interface BinanceCredentials {
    apiKey: string
    apiSecret: string
    baseUrl?: string
    recvWindow?: number
}

export interface BinanceAccountInfo {
    availableBalance: string
    totalWalletBalance: string
    totalUnrealizedProfit: string
    totalInitialMargin: string
    totalMaintMargin: string
}

export interface BinancePositionRisk {
    symbol: string
    positionAmt: string
    entryPrice: string
    markPrice: string
    unRealizedProfit: string
    liquidationPrice: string
    leverage: string
    marginType: string
}

export interface BinanceExchangeInfo {
    timezone: string
    symbols: BinanceExchangeSymbol[]
}

export interface BinanceExchangeSymbol {
    symbol: string
    status: string
    pricePrecision: number
    quantityPrecision: number
    filters: Array<Record<string, string>>
}

export interface BinanceOrderResponse {
    symbol: string
    orderId: number
    status: string
    type: string
    side: "BUY" | "SELL"
    price: string
    avgPrice: string
    origQty: string
    executedQty: string
    stopPrice: string
    reduceOnly: boolean
    updateTime?: number
    time?: number
}

export interface BinanceBookTicker {
    symbol: string
    bidPrice: string
    askPrice: string
}

export interface BinancePremiumIndex {
    symbol: string
    markPrice: string
    indexPrice: string
    lastFundingRate: string
    nextFundingTime: number
    time: number
}

export interface BinanceFundingRate {
    symbol: string
    fundingRate: string
    fundingTime: number
    markPrice: string
}

export interface BinanceCreateOrderParams {
    symbol: string
    side: "BUY" | "SELL"
    type: "MARKET" | "LIMIT" | "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET"
    quantity?: number
    price?: number
    stopPrice?: number
    timeInForce?: "GTC" | "IOC" | "FOK" | "GTX"
    reduceOnly?: boolean
    closePosition?: boolean
    workingType?: "MARK_PRICE" | "CONTRACT_PRICE"
}

export class BinanceApiError extends Error {
    readonly status: number
    readonly code?: number
    readonly retryable: boolean
    readonly executionError: ExecutionErrorDetail

    constructor(message: string, status: number, code?: number) {
        super(message)
        this.status = status
        this.code = code
        this.retryable = isRetryableBinanceError(status, code)
        this.executionError = createExecutionErrorDetail("venue", message, {
            code: code !== undefined ? String(code) : undefined,
            retryable: this.retryable,
            details: {
                status,
            },
        })
    }
}

const DEFAULT_BASE_URL = "https://fapi.binance.com"
const DEFAULT_RECV_WINDOW = 5000
const BINANCE_REQUEST_TIMEOUT_MS = 30_000

export class BinanceClient {
    private readonly apiKey: string
    private readonly apiSecret: string
    private readonly baseUrl: string
    private readonly recvWindow: number
    private usedWeight1m: number | null = null

    constructor(credentials: BinanceCredentials) {
        this.apiKey = credentials.apiKey
        this.apiSecret = credentials.apiSecret
        this.baseUrl = normalizeBaseUrl(credentials.baseUrl)
        this.recvWindow = credentials.recvWindow ?? DEFAULT_RECV_WINDOW
    }

    getBaseUrl(): string {
        return this.baseUrl
    }

    getUsedWeight1m(): number | null {
        return this.usedWeight1m
    }

    async ping(): Promise<void> {
        await this.publicRequest<unknown>("GET", "/fapi/v1/ping")
    }

    async getExchangeInfo(): Promise<BinanceExchangeInfo> {
        return await this.publicRequest<BinanceExchangeInfo>("GET", "/fapi/v1/exchangeInfo")
    }

    async getAccount(): Promise<BinanceAccountInfo> {
        return await this.signedRequest<BinanceAccountInfo>("GET", "/fapi/v2/account")
    }

    async getPositionRisk(symbol?: string): Promise<BinancePositionRisk[]> {
        return await this.signedRequest<BinancePositionRisk[]>("GET", "/fapi/v2/positionRisk", {
            symbol,
        })
    }

    async getOrder(symbol: string, orderId: number): Promise<BinanceOrderResponse> {
        return await this.signedRequest<BinanceOrderResponse>("GET", "/fapi/v1/order", {
            symbol,
            orderId,
        })
    }

    async getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
        return await this.signedRequest<BinanceOrderResponse[]>("GET", "/fapi/v1/openOrders", {
            symbol,
        })
    }

    async createOrder(params: BinanceCreateOrderParams): Promise<BinanceOrderResponse> {
        const payload: Record<string, string | number | boolean | undefined> = {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            quantity: params.quantity,
            price: params.price,
            stopPrice: params.stopPrice,
            timeInForce: params.timeInForce,
            reduceOnly: params.reduceOnly,
            closePosition: params.closePosition,
            workingType: params.workingType,
        }

        return await this.signedRequest<BinanceOrderResponse>("POST", "/fapi/v1/order", payload)
    }

    async cancelOrder(symbol: string, orderId: number): Promise<BinanceOrderResponse> {
        return await this.signedRequest<BinanceOrderResponse>("DELETE", "/fapi/v1/order", {
            symbol,
            orderId,
        })
    }

    async setLeverage(symbol: string, leverage: number): Promise<{ leverage: number }> {
        return await this.signedRequest<{ leverage: number }>("POST", "/fapi/v1/leverage", {
            symbol,
            leverage,
        })
    }

    async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<void> {
        await this.signedRequest<unknown>("POST", "/fapi/v1/marginType", {
            symbol,
            marginType,
        })
    }

    async setPositionMode(dualSidePosition: boolean): Promise<void> {
        await this.signedRequest<unknown>("POST", "/fapi/v1/positionSide/dual", {
            dualSidePosition: dualSidePosition ? "true" : "false",
        })
    }

    async getBookTicker(symbol: string): Promise<BinanceBookTicker> {
        return await this.publicRequest<BinanceBookTicker>("GET", "/fapi/v1/ticker/bookTicker", {
            symbol,
        })
    }

    async getPremiumIndex(symbol: string): Promise<BinancePremiumIndex> {
        return await this.publicRequest<BinancePremiumIndex>("GET", "/fapi/v1/premiumIndex", {
            symbol,
        })
    }

    async getFundingRates(symbol: string, limit = 1): Promise<BinanceFundingRate[]> {
        return await this.publicRequest<BinanceFundingRate[]>("GET", "/fapi/v1/fundingRate", {
            symbol,
            limit,
        })
    }

    private async publicRequest<T>(
        method: "GET" | "POST",
        path: string,
        params?: Record<string, string | number | boolean | undefined>
    ): Promise<T> {
        return await retryWithBackoff(async () => {
            const query = buildQuery(params)
            const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`
            const response = await fetchWithTimeout(url, {
                method,
                headers: {
                    "Content-Type": "application/json",
                },
            }, BINANCE_REQUEST_TIMEOUT_MS, `Binance request ${path}`)
            this.captureRateLimitHeaders(response)
            return await parseBinanceResponse<T>(response)
        }, 2, 300)
    }

    private async signedRequest<T>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        params?: Record<string, string | number | boolean | undefined>
    ): Promise<T> {
        return await retryWithBackoff(async () => {
            const signedParams = {
                ...params,
                timestamp: Date.now(),
                recvWindow: this.recvWindow,
            }
            const query = buildQuery(signedParams)
            const signature = this.sign(query)
            const url = `${this.baseUrl}${path}?${query}&signature=${signature}`
            const response = await fetchWithTimeout(url, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    "X-MBX-APIKEY": this.apiKey,
                },
            }, BINANCE_REQUEST_TIMEOUT_MS, `Binance signed request ${path}`)
            this.captureRateLimitHeaders(response)
            return await parseBinanceResponse<T>(response)
        }, 2, 300)
    }

    private captureRateLimitHeaders(response: Response): void {
        const usedWeight = response.headers.get("x-mbx-used-weight-1m")
        if (!usedWeight) {
            return
        }

        const parsed = Number(usedWeight)
        if (Number.isFinite(parsed)) {
            this.usedWeight1m = parsed
        }
    }

    private sign(query: string): string {
        return createHmac("sha256", this.apiSecret).update(query).digest("hex")
    }
}

function buildQuery(params?: Record<string, string | number | boolean | undefined>): string {
    if (!params) {
        return ""
    }

    const searchParams = new URLSearchParams()

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
            continue
        }
        searchParams.set(key, String(value))
    }

    return searchParams.toString()
}

async function parseBinanceResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
        if (response.status === 204) {
            return {} as T
        }

        return await response.json() as T
    }

    let code: number | undefined
    let message = `${response.status} ${response.statusText}`

    try {
        const payload = await response.json() as { code?: number; msg?: string }
        code = payload.code
        if (payload.msg) {
            message = payload.msg
        }
    } catch {
        const text = await response.text().catch(() => "")
        if (text) {
            message = text
        }
    }

    throw new BinanceApiError(message, response.status, code)
}

function normalizeBaseUrl(value?: string): string {
    return (value ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

function isRetryableBinanceError(status: number, code?: number): boolean {
    if (status >= 500 || status === 429) {
        return true
    }

    if (code === undefined) {
        return false
    }

    const retryableCodes = new Set([-1001, -1003, -1006, -1007, -1008, -1021, -1022])
    return retryableCodes.has(code)
}
