/**
 * MT5 HTTP client -- communicates with the Python worker over HTTP.
 *
 * The Python worker wraps the MT5 SDK. This client proxies the VenueAdapter
 * interface calls to the worker's REST endpoints.
 */

import {
    createExecutionError,
    createExecutionErrorDetail,
    fetchWithTimeout,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
    retryWithBackoff,
    type ExecutionResult,
    type OrderIntent,
} from "@valiq-trading/core"

export interface MT5WorkerCredentials {
    login: number
    password: string
    server: string
}

export interface MT5ClientConfig {
    /** Base URL of the Python worker */
    workerUrl: string
    /** Shared access key for auth */
    accessKey?: string
    /** Request timeout in ms */
    timeout?: number
    connectTimeout?: number
    fetchImpl?: typeof fetch
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

export interface MT5PositionClosure {
    ticket: number
    orderId: number
    positionId: number
    symbol: string
    side: "long" | "short"
    volume: number
    price: number
    profit: number
    swap?: number
    commission?: number
    fee?: number
    timeDone: number
    entry: number
    reason: number
}

export interface MT5AccountPnlEvent {
    providerEventId: string
    eventType: "funding_fee" | "fee" | "adjustment"
    instrument?: string
    amount: number
    currency: string
    occurredAt: number
    metadata?: Record<string, unknown>
}

export interface MT5OpenOrder {
    ticket: number
    symbol: string
    type: string
    volumeInitial: number
    volumeCurrent: number
    priceOpen: number
    stopLoss: number
    takeProfit: number
    state: string
    comment: string
    magic: number
    timeSetup: number
    timeDone: number
}

export interface MT5OrderResult {
    retcode: number
    retcodeDescription: string
    retcodeExternal?: number
    orderId: string
    dealId?: string
    volume: number
    price: number
    comment?: string
    bid?: number
    ask?: number
    success: boolean
}

export interface MT5SymbolInfo {
    symbol: string
    digits: number
    point: number
    pipSize: number
    tickValue: number
    contractSize: number
    currency: string
    description: string
    spread: number
    volumeMin: number
    volumeMax: number
    volumeStep: number
    fillingMode: number
    bid: number
    ask: number
}

type MT5WorkerErrorDetail = {
    error?: string
    errorType?: string
    retryable?: boolean
    [key: string]: unknown
}

type MT5WorkerErrorBody = {
    detail?: string | MT5WorkerErrorDetail
    error?: string
    errorType?: string
    retryable?: boolean
}

export class MT5Client {
    private readonly workerUrl: string
    private readonly accessKey: string
    private readonly timeout: number
    private readonly connectTimeout: number
    private readonly fetchImpl: typeof fetch

    constructor(config: MT5ClientConfig) {
        this.workerUrl = config.workerUrl.replace(/\/$/, "")
        this.accessKey = config.accessKey ?? ""
        this.timeout = config.timeout ?? 30_000
        this.connectTimeout = config.connectTimeout ?? Math.max(this.timeout, 90_000)
        this.fetchImpl = config.fetchImpl ?? fetch
    }

    async connect(credentials: MT5WorkerCredentials): Promise<MT5AccountInfo> {
        const response = await this.postMutation<{
            success: boolean
            accountInfo?: MT5AccountInfo
            error?: string
            errorType?: string
            retryable?: boolean
        }>("/connect", credentials, this.connectTimeout)

        if (!response.success) {
            throw createExecutionError("venue", `MT5 connection failed: ${response.error ?? "unknown error"}`, {
                code: response.errorType ?? "unknown",
                retryable: response.retryable ?? true,
                details: {
                    workerUrl: this.workerUrl,
                    login: credentials.login,
                    server: credentials.server,
                },
            })
        }

        return response.accountInfo!
    }

    async disconnect(): Promise<void> {
        try {
            await this.postMutation("/disconnect", {})
        } catch {
            // Best effort
        }
    }

    async getHealth(): Promise<{ status: string; connected: boolean; login: number | null }> {
        return await this.get("/health")
    }

    async getAccount(credentials: MT5WorkerCredentials): Promise<MT5AccountInfo> {
        return await this.postRead<MT5AccountInfo>("/account", this.accountScopedBody(credentials))
    }

    async getPositions(credentials: MT5WorkerCredentials): Promise<MT5Position[]> {
        return await this.postRead<MT5Position[]>("/positions", this.accountScopedBody(credentials))
    }

    async getOpenOrders(credentials: MT5WorkerCredentials): Promise<MT5OpenOrder[]> {
        return await this.postRead<MT5OpenOrder[]>("/orders", this.accountScopedBody(credentials))
    }

    async getPositionClosures(
        credentials: MT5WorkerCredentials,
        lookbackHours: number = 24
    ): Promise<MT5PositionClosure[]> {
        return await this.postRead<MT5PositionClosure[]>("/position/closures", this.accountScopedBody(credentials, {
            lookbackHours,
        }))
    }

    async getAccountPnlEvents(
        credentials: MT5WorkerCredentials,
        lookbackHours: number = 24
    ): Promise<MT5AccountPnlEvent[]> {
        return await this.postRead<MT5AccountPnlEvent[]>("/account/pnl-events", this.accountScopedBody(credentials, {
            lookbackHours,
        }))
    }

    async submitOrder(credentials: MT5WorkerCredentials, params: {
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
        return await this.postMutation<MT5OrderResult>("/order/submit", this.accountScopedBody(credentials, params))
    }

    async modifyOrder(credentials: MT5WorkerCredentials, params: {
        ticket: number
        price?: number
        stopLoss?: number
        takeProfit?: number
    }): Promise<MT5OrderResult> {
        return await this.postMutation<MT5OrderResult>("/order/modify", this.accountScopedBody(credentials, params))
    }

    async cancelOrder(credentials: MT5WorkerCredentials, params: {
        ticket: number
    }): Promise<MT5OrderResult> {
        return await this.postMutation<MT5OrderResult>("/order/cancel", this.accountScopedBody(credentials, params))
    }

    async cancelAllOrders(credentials: MT5WorkerCredentials): Promise<{ cancelled: number; results: MT5OrderResult[] }> {
        return await this.postMutation("/order/cancel-all", this.accountScopedBody(credentials))
    }

    async closePosition(credentials: MT5WorkerCredentials, params: {
        ticket: number
        volume?: number
        deviation?: number
        comment?: string
    }): Promise<MT5OrderResult> {
        return await this.postMutation<MT5OrderResult>("/position/close", this.accountScopedBody(credentials, params))
    }

    async closeAllPositions(credentials: MT5WorkerCredentials): Promise<{ closed: number; results: MT5OrderResult[] }> {
        return await this.postMutation("/position/close-all", this.accountScopedBody(credentials))
    }

    async getSymbolInfo(credentials: MT5WorkerCredentials, symbols: string[]): Promise<MT5SymbolInfo[]> {
        return await this.postRead<MT5SymbolInfo[]>("/symbol/info", this.accountScopedBody(credentials, { symbols }))
    }

    async getOrderStatus(credentials: MT5WorkerCredentials, orderId: number): Promise<{
        ticket: number
        symbol: string
        type: string
        volume: number
        volumeInitial?: number
        price: number
        profit?: number
        commission?: number
        swap?: number
        fee?: number
        state: string
    } | null> {
        try {
            return await this.postRead("/order/status", this.accountScopedBody(credentials, { orderId }))
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes("404")) {
                return null
            }
            throw error
        }
    }

    // -- Mapping helpers for VenueAdapter -------------------------------------

    mapOrderResultToExecution(
        result: MT5OrderResult,
        options: {
            fallbackOrderId?: string
            successStatus?: ExecutionResult["status"]
            filledQuantity?: number
            fillPrice?: number
            successRetcodes?: number[]
        } = {}
    ): ExecutionResult {
        const success = result.success || (options.successRetcodes ?? []).includes(result.retcode)
        const errorDetail = success
            ? undefined
            : createExecutionErrorDetail("venue", result.retcodeDescription, {
                code: String(result.retcode),
                retryable: result.retcode === 10004 || result.retcode === 10020 || result.retcode === 10024 || result.retcode === 10031,
                details: {
                    retcode: result.retcode,
                    retcodeExternal: result.retcodeExternal,
                    comment: result.comment,
                    bid: result.bid,
                    ask: result.ask,
                },
            })

        return {
            orderId: result.orderId || result.dealId || options.fallbackOrderId || "",
            providerOrderId: result.orderId || result.dealId || options.fallbackOrderId || undefined,
            status: success ? options.successStatus ?? resolveMT5MutationSuccessStatus(result) : "rejected",
            filledQuantity: success ? options.filledQuantity ?? result.volume : 0,
            fillPrice: success
                ? options.fillPrice ?? (result.price > 0 ? result.price : undefined)
                : undefined,
            timestamp: Date.now(),
            error: errorDetail ? formatExecutionError(errorDetail) : undefined,
            errorDetail,
        }
    }

    // -- HTTP transport -------------------------------------------------------

    private accountScopedBody(
        credentials: MT5WorkerCredentials,
        params: Record<string, unknown> = {}
    ): Record<string, unknown> {
        return {
            ...params,
            login: credentials.login,
            password: credentials.password,
            server: credentials.server,
        }
    }

    private async get<T = unknown>(path: string): Promise<T> {
        return await retryWithBackoff(async () => {
            return await this.request<T>("GET", path, undefined, this.timeout)
        }, 3, 1000)
    }

    private async postRead<T = unknown>(path: string, body: unknown): Promise<T> {
        return await retryWithBackoff(async () => {
            return await this.request<T>("POST", path, body, this.timeout)
        }, 3, 1000)
    }

    private async postMutation<T = unknown>(
        path: string,
        body: unknown,
        timeout: number = this.timeout
    ): Promise<T> {
        return await this.request<T>("POST", path, body, timeout)
    }

    private async request<T = unknown>(
        method: "GET" | "POST",
        path: string,
        body: unknown,
        timeout: number
    ): Promise<T> {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        try {
            const response = await fetchWithTimeout(`${this.workerUrl}${path}`, {
                method,
                headers: this.headers(),
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            }, timeout, `MT5 worker ${method} ${path}`, this.fetchImpl)

            if (!response.ok) {
                const text = await response.text().catch(() => "")
                const workerError = parseWorkerError(text)
                const message = workerError?.error ?? text
                throw createExecutionError("venue", `MT5 worker error: ${response.status} ${response.statusText} ${message}`.trim(), {
                    code: workerError?.errorType ?? String(response.status),
                    retryable: workerError?.retryable ?? (response.status >= 500 || response.status === 429),
                    details: {
                        path,
                        status: response.status,
                        statusText: response.statusText,
                        body: text,
                        workerError,
                    },
                })
            }

            return (await response.json()) as T
        } catch (error) {
            const detail = getExecutionErrorDetail(error)
            if (detail) {
                throw error
            }

            throw createExecutionError("network", getErrorMessage(error), {
                code: "MT5_WORKER_NETWORK",
                retryable: true,
                details: {
                    method,
                    path,
                    workerUrl: this.workerUrl,
                },
            })
        } finally {
            clearTimeout(timeoutId)
        }
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = { "Content-Type": "application/json" }
        if (this.accessKey) {
            h["x-worker-key"] = this.accessKey
        }
        return h
    }
}

function resolveMT5MutationSuccessStatus(result: MT5OrderResult): ExecutionResult["status"] {
    return result.retcode === 10010 ? "partially_filled" : "filled"
}

function parseWorkerError(text: string): MT5WorkerErrorDetail | undefined {
    if (!text.trim()) {
        return undefined
    }

    let parsed: MT5WorkerErrorBody
    try {
        parsed = JSON.parse(text) as MT5WorkerErrorBody
    } catch {
        return undefined
    }

    if (typeof parsed.detail === "string") {
        return {
            error: parsed.detail,
        }
    }

    if (isRecord(parsed.detail)) {
        return parsed.detail as MT5WorkerErrorDetail
    }

    if (parsed.error || parsed.errorType || parsed.retryable !== undefined) {
        return {
            error: parsed.error,
            errorType: parsed.errorType,
            retryable: parsed.retryable,
        }
    }

    return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isRecoverableMT5ConnectionError(error: unknown): boolean {
    const detail = getExecutionErrorDetail(error)
    if (!detail?.retryable) {
        return false
    }

    return detail.code === "not_connected"
        || detail.code === "session_lost"
        || detail.code === "connect_in_progress"
        || detail.code === "operation_in_progress"
}
