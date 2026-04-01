/**
 * MT5 HTTP client -- communicates with the Python worker over HTTP.
 *
 * The Python worker wraps the MT5 SDK. This client proxies the VenueAdapter
 * interface calls to the worker's REST endpoints.
 */

import { retryWithBackoff, type ExecutionResult, type OrderIntent } from "@valiq-trading/core"

export interface MT5WorkerCredentials {
    login: number
    password: string
    server: string
}

export interface MT5ClientConfig {
    /** Base URL of the Python worker (e.g. http://192.168.1.100:8090) */
    workerUrl: string
    /** Shared access key for auth */
    accessKey?: string
    /** Request timeout in ms */
    timeout?: number
}

export interface MT5AccountInfo {
    login: number
    name: string
    server: string
    company: string
    balance: number
    equity: number
    margin: number
    freeMargin: number
    marginLevel: number
    currency: string
    leverage: number
    profit: number
}

export interface MT5Position {
    ticket: number
    symbol: string
    type: "buy" | "sell"
    volume: number
    openPrice: number
    currentPrice: number
    stopLoss: number
    takeProfit: number
    profit: number
    swap: number
    commission: number
    magic: number
    comment: string
    openTime: number
    identifier: number
}

export interface MT5OrderResult {
    retcode: number
    retcodeDescription: string
    orderId: string
    dealId?: string
    volume: number
    price: number
    comment?: string
    success: boolean
}

export interface MT5SymbolInfo {
    symbol: string
    digits: number
    point: number
    pipSize: number
    pipValue: number
    contractSize: number
    currency: string
    description: string
    spread: number
    volumeMin: number
    volumeMax: number
    volumeStep: number
    fillingMode: number
}

export class MT5Client {
    private readonly workerUrl: string
    private readonly accessKey: string
    private readonly timeout: number
    private connected = false

    constructor(config: MT5ClientConfig) {
        this.workerUrl = config.workerUrl.replace(/\/$/, "")
        this.accessKey = config.accessKey ?? ""
        this.timeout = config.timeout ?? 30_000
    }

    async connect(credentials: MT5WorkerCredentials): Promise<MT5AccountInfo> {
        const response = await this.post<{
            success: boolean
            accountInfo?: MT5AccountInfo
            error?: string
            errorType?: string
            retryable?: boolean
        }>("/connect", credentials)

        if (!response.success) {
            throw new Error(
                `MT5 connection failed (${response.errorType ?? "unknown"}): ${response.error ?? "unknown error"}`
            )
        }

        this.connected = true
        return response.accountInfo!
    }

    async disconnect(): Promise<void> {
        try {
            await this.post("/disconnect", {})
        } catch {
            // Best effort
        }
        this.connected = false
    }

    async getHealth(): Promise<{ status: string; connected: boolean; login: number | null }> {
        return await this.get("/health")
    }

    async getAccount(): Promise<MT5AccountInfo> {
        return await this.get<MT5AccountInfo>("/account")
    }

    async getPositions(): Promise<MT5Position[]> {
        return await this.get<MT5Position[]>("/positions")
    }

    async submitOrder(params: {
        symbol: string
        side: string
        volume: number
        orderType?: string
        price?: number
        stopLoss?: number
        takeProfit?: number
        magic?: number
        comment?: string
        deviation?: number
    }): Promise<MT5OrderResult> {
        return await this.post<MT5OrderResult>("/order/submit", params)
    }

    async modifyPosition(params: {
        ticket: number
        stopLoss?: number
        takeProfit?: number
    }): Promise<MT5OrderResult> {
        return await this.post<MT5OrderResult>("/order/modify", params)
    }

    async closePosition(params: {
        ticket: number
        volume?: number
        deviation?: number
    }): Promise<MT5OrderResult> {
        return await this.post<MT5OrderResult>("/position/close", params)
    }

    async closeAllPositions(): Promise<{ closed: number; results: MT5OrderResult[] }> {
        return await this.post("/position/close-all", {})
    }

    async getSymbolInfo(symbols: string[]): Promise<MT5SymbolInfo[]> {
        return await this.post<MT5SymbolInfo[]>("/symbol/info", { symbols })
    }

    async getOrderStatus(orderId: number): Promise<{
        ticket: number
        symbol: string
        type: string
        volume: number
        price: number
        state: string
    } | null> {
        try {
            return await this.post("/order/status", { orderId })
        } catch {
            return null
        }
    }

    // -- Mapping helpers for VenueAdapter -------------------------------------

    mapOrderResultToExecution(result: MT5OrderResult): ExecutionResult {
        return {
            orderId: result.orderId || result.dealId || "",
            status: result.success ? "filled" : "rejected",
            filledQuantity: result.success ? result.volume : 0,
            fillPrice: result.success ? result.price : undefined,
            timestamp: Date.now(),
            error: result.success ? undefined : result.retcodeDescription,
        }
    }

    // -- HTTP transport -------------------------------------------------------

    private async get<T = unknown>(path: string): Promise<T> {
        return await retryWithBackoff(async () => {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), this.timeout)

            try {
                const response = await fetch(`${this.workerUrl}${path}`, {
                    method: "GET",
                    headers: this.headers(),
                    signal: controller.signal,
                })

                if (!response.ok) {
                    const body = await response.text().catch(() => "")
                    throw new Error(`MT5 worker error: ${response.status} ${response.statusText} ${body}`)
                }

                return (await response.json()) as T
            } finally {
                clearTimeout(timeoutId)
            }
        }, 3, 1000)
    }

    private async post<T = unknown>(path: string, body: unknown): Promise<T> {
        return await retryWithBackoff(async () => {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), this.timeout)

            try {
                const response = await fetch(`${this.workerUrl}${path}`, {
                    method: "POST",
                    headers: this.headers(),
                    body: JSON.stringify(body),
                    signal: controller.signal,
                })

                if (!response.ok) {
                    const text = await response.text().catch(() => "")
                    throw new Error(`MT5 worker error: ${response.status} ${response.statusText} ${text}`)
                }

                return (await response.json()) as T
            } finally {
                clearTimeout(timeoutId)
            }
        }, 3, 1000)
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = { "Content-Type": "application/json" }
        if (this.accessKey) {
            h["x-worker-key"] = this.accessKey
        }
        return h
    }
}
