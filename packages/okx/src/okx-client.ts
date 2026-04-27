import { createHmac } from "crypto"
import {
    createExecutionErrorDetail,
    fetchWithTimeout,
    getExecutionErrorDetail,
    type ExecutionErrorDetail,
} from "@valiq-trading/core"

export type OKXMarginMode = "cross" | "isolated"
export type OKXPositionMode = "net_mode" | "long_short_mode"
export type OKXApiPosSide = "net" | "long" | "short"
export type OKXOrderType = "market" | "limit" | "ioc" | "fok" | "conditional"

export interface OKXCredentials {
    apiKey: string
    apiSecret: string
    apiPassphrase: string
    baseUrl?: string
    demoTrading: boolean
}

export interface OKXPublicTime {
    ts: string
}

export interface OKXAccountConfig {
    acctLv: string
    posMode: string
}

export interface OKXAccountBalanceDetail {
    ccy: string
    availBal?: string
    availEq?: string
    cashBal?: string
    eq?: string
    eqUsd?: string
}

export interface OKXAccountBalance {
    totalEq: string
    upl: string
    imr?: string
    mmr?: string
    availEq?: string
    adjEq?: string
    details: OKXAccountBalanceDetail[]
}

export interface OKXPosition {
    instId: string
    instType: string
    posId?: string
    pos: string
    posSide: string
    avgPx: string
    markPx: string
    upl: string
    lever?: string
    mgnMode: string
    liqPx?: string
    cTime?: string
    uTime?: string
}

export interface OKXInstrument {
    instId: string
    instType: string
    state: string
    baseCcy?: string
    quoteCcy?: string
    settleCcy?: string
    ctVal: string
    ctValCcy?: string
    ctMult?: string
    lotSz: string
    minSz: string
    tickSz: string
    lever?: string
    ctType?: string
}

export interface OKXOrder {
    instId: string
    ordId: string
    clOrdId?: string
    state: string
    ordType: string
    side: "buy" | "sell"
    sz: string
    accFillSz: string
    px: string
    avgPx: string
    reduceOnly?: string
    posSide?: string
    tdMode?: string
    cTime?: string
    uTime?: string
    slTriggerPx?: string
    tpTriggerPx?: string
}

export interface OKXAlgoOrder {
    algoId: string
    instId: string
    ordType: string
    side: "buy" | "sell"
    posSide?: string
    slTriggerPx?: string
    tpTriggerPx?: string
    cTime?: string
    uTime?: string
    state?: string
}

export interface OKXOrderAck {
    ordId: string
    clOrdId?: string
    sCode: string
    sMsg: string
}

export interface OKXAlgoOrderAck {
    algoId: string
    sCode: string
    sMsg: string
}

export type OKXOrderBookLevel = [string, string, string, string]

export interface OKXOrderBook {
    asks: OKXOrderBookLevel[]
    bids: OKXOrderBookLevel[]
    ts: string
}

export interface OKXTicker {
    instId: string
    bidPx: string
    askPx: string
    last: string
    ts: string
}

export interface OKXMarkPrice {
    instId: string
    markPx: string
    ts: string
}

export interface OKXFundingRate {
    instId: string
    fundingRate: string
    nextFundingRate?: string
    fundingTime: string
    nextFundingTime?: string
}

export interface OKXPlaceOrderParams {
    instId: string
    tdMode: OKXMarginMode
    side: "buy" | "sell"
    ordType: Exclude<OKXOrderType, "conditional">
    sz: string
    px?: string
    posSide?: OKXApiPosSide
    reduceOnly?: boolean
    attachAlgoOrds?: OKXAttachedAlgoOrderParams[]
}

export interface OKXAmendOrderParams {
    instId: string
    ordId: string
    newSz?: string
    newPx?: string
}

export interface OKXSetLeverageParams {
    instId: string
    lever: string
    mgnMode: OKXMarginMode
    posSide?: Exclude<OKXApiPosSide, "net">
}

export interface OKXPlaceAlgoOrderParams {
    instId: string
    tdMode: OKXMarginMode
    side: "buy" | "sell"
    posSide?: OKXApiPosSide
    ordType: "conditional" | "oco"
    sz: string
    slTriggerPx?: string
    slOrdPx?: string
    tpTriggerPx?: string
    tpOrdPx?: string
}

type OKXAlgoOrderType = "conditional" | "oco"

export interface OKXAttachedAlgoOrderParams {
    slTriggerPx?: string
    slOrdPx?: string
    tpTriggerPx?: string
    tpOrdPx?: string
}

export interface OKXCancelAlgoOrderParams {
    algoId: string
    instId: string
}

interface OKXResponseEnvelope<T> {
    code: string
    msg: string
    data: T[]
}

export class OKXApiError extends Error {
    readonly status: number
    readonly code?: string
    readonly retryable: boolean
    readonly executionError: ExecutionErrorDetail

    constructor(
        message: string,
        status: number,
        code?: string,
        details?: Record<string, unknown>
    ) {
        super(message)
        this.status = status
        this.code = code
        this.retryable = isRetryableOKXError(status, code)
        this.executionError = createExecutionErrorDetail("venue", message, {
            code,
            retryable: this.retryable,
            details: {
                status,
                ...details,
            },
        })
    }
}

const DEFAULT_BASE_URL = "https://www.okx.com"
const OKX_REQUEST_TIMEOUT_MS = 30_000
const OKX_MAX_RETRIES = 2
const OKX_BASE_DELAY_MS = 300

export class OKXClient {
    private readonly apiKey: string
    private readonly apiSecret: string
    private readonly apiPassphrase: string
    private readonly baseUrl: string
    private readonly demoTrading: boolean

    constructor(credentials: OKXCredentials) {
        this.apiKey = credentials.apiKey
        this.apiSecret = credentials.apiSecret
        this.apiPassphrase = credentials.apiPassphrase
        this.baseUrl = normalizeBaseUrl(credentials.baseUrl)
        this.demoTrading = credentials.demoTrading
    }

    getBaseUrl(): string {
        return this.baseUrl
    }

    isDemoTrading(): boolean {
        return this.demoTrading
    }

    async getPublicTime(): Promise<OKXPublicTime> {
        const data = await this.publicRequest<OKXPublicTime>("GET", "/api/v5/public/time")
        return requireFirst(data, "OKX public time")
    }

    async getAccountConfig(): Promise<OKXAccountConfig> {
        const data = await this.privateRequest<OKXAccountConfig>("GET", "/api/v5/account/config")
        return requireFirst(data, "OKX account config")
    }

    async getBalance(): Promise<OKXAccountBalance> {
        const data = await this.privateRequest<OKXAccountBalance>("GET", "/api/v5/account/balance")
        return requireFirst(data, "OKX account balance")
    }

    async getPositions(
        instType: "SWAP" = "SWAP",
        instId?: string
    ): Promise<OKXPosition[]> {
        return await this.privateRequest<OKXPosition>("GET", "/api/v5/account/positions", {
            instType,
            instId,
        })
    }

    async getInstruments(
        instType: "SWAP" = "SWAP",
        instId?: string
    ): Promise<OKXInstrument[]> {
        return await this.publicRequest<OKXInstrument>("GET", "/api/v5/public/instruments", {
            instType,
            instId,
        })
    }

    async getOrder(instId: string, ordId: string): Promise<OKXOrder> {
        const data = await this.privateRequest<OKXOrder>("GET", "/api/v5/trade/order", {
            instId,
            ordId,
        })
        return requireFirst(data, "OKX order")
    }

    async getOrdersPending(
        instType: "SWAP" = "SWAP",
        instId?: string
    ): Promise<OKXOrder[]> {
        return await this.privateRequest<OKXOrder>("GET", "/api/v5/trade/orders-pending", {
            instType,
            instId,
        })
    }

    async placeOrder(params: OKXPlaceOrderParams): Promise<OKXOrderAck> {
        const data = await this.privateRequest<OKXOrderAck>("POST", "/api/v5/trade/order", undefined, {
            instId: params.instId,
            tdMode: params.tdMode,
            side: params.side,
            ordType: params.ordType,
            sz: params.sz,
            px: params.px,
            posSide: params.posSide,
            reduceOnly: params.reduceOnly === true ? "true" : undefined,
            attachAlgoOrds: params.attachAlgoOrds,
        })

        const ack = requireFirst(data, "OKX place order acknowledgement")
        assertAckSuccess(ack.sCode, ack.sMsg, "OKX order placement")
        return ack
    }

    async cancelOrder(instId: string, ordId: string): Promise<OKXOrderAck> {
        const data = await this.privateRequest<OKXOrderAck>("POST", "/api/v5/trade/cancel-order", undefined, {
            instId,
            ordId,
        })

        const ack = requireFirst(data, "OKX cancel order acknowledgement")
        assertAckSuccess(ack.sCode, ack.sMsg, "OKX order cancellation")
        return ack
    }

    async amendOrder(params: OKXAmendOrderParams): Promise<OKXOrderAck> {
        const data = await this.privateRequest<OKXOrderAck>("POST", "/api/v5/trade/amend-order", undefined, {
            instId: params.instId,
            ordId: params.ordId,
            newSz: params.newSz,
            newPx: params.newPx,
        })

        const ack = requireFirst(data, "OKX amend order acknowledgement")
        assertAckSuccess(ack.sCode, ack.sMsg, "OKX order amend")
        return ack
    }

    async getOrderBook(instId: string, sz = 20): Promise<OKXOrderBook> {
        const data = await this.publicRequest<OKXOrderBook>("GET", "/api/v5/market/books", {
            instId,
            sz,
        })
        return requireFirst(data, "OKX order book")
    }

    async getTicker(instId: string): Promise<OKXTicker> {
        const data = await this.publicRequest<OKXTicker>("GET", "/api/v5/market/ticker", {
            instId,
        })
        return requireFirst(data, "OKX ticker")
    }

    async getMarkPrice(instId: string): Promise<OKXMarkPrice> {
        const data = await this.publicRequest<OKXMarkPrice>("GET", "/api/v5/public/mark-price", {
            instType: "SWAP",
            instId,
        })
        return requireFirst(data, "OKX mark price")
    }

    async getFundingRate(instId: string): Promise<OKXFundingRate> {
        const data = await this.publicRequest<OKXFundingRate>("GET", "/api/v5/public/funding-rate", {
            instId,
        })
        return requireFirst(data, "OKX funding rate")
    }

    async getFundingRateHistory(
        instId: string,
        limit = 1
    ): Promise<OKXFundingRate[]> {
        return await this.publicRequest<OKXFundingRate>("GET", "/api/v5/public/funding-rate-history", {
            instId,
            limit,
        })
    }

    async setLeverage(params: OKXSetLeverageParams): Promise<void> {
        const data = await this.privateRequest<{ lever: string; sCode?: string; sMsg?: string }>(
            "POST",
            "/api/v5/account/set-leverage",
            undefined,
            {
                instId: params.instId,
                lever: params.lever,
                mgnMode: params.mgnMode,
                posSide: params.posSide,
            }
        )

        const response = requireFirst(data, "OKX leverage acknowledgement")
        if (response.sCode !== undefined || response.sMsg !== undefined) {
            assertAckSuccess(response.sCode ?? "0", response.sMsg ?? "", "OKX leverage update")
        }
    }

    async placeAlgoOrder(params: OKXPlaceAlgoOrderParams): Promise<OKXAlgoOrderAck> {
        const request = {
            instId: params.instId,
            tdMode: params.tdMode,
            side: params.side,
            posSide: params.posSide,
            ordType: params.ordType,
            sz: params.sz,
            slTriggerPx: params.slTriggerPx,
            slOrdPx: params.slOrdPx,
            tpTriggerPx: params.tpTriggerPx,
            tpOrdPx: params.tpOrdPx,
        }
        const data = await this.privateRequest<OKXAlgoOrderAck>("POST", "/api/v5/trade/order-algo", undefined, request)

        const ack = requireFirst(data, "OKX algo order acknowledgement")
        assertAckSuccess(ack.sCode, ack.sMsg, "OKX algo order placement", {
            path: "/api/v5/trade/order-algo",
            request,
            sCode: ack.sCode,
            sMsg: ack.sMsg,
        })
        return ack
    }

    async cancelAlgoOrders(
        orders: OKXCancelAlgoOrderParams[]
    ): Promise<OKXAlgoOrderAck[]> {
        const data = await this.privateRequest<OKXAlgoOrderAck>(
            "POST",
            "/api/v5/trade/cancel-algos",
            undefined,
            orders.map((order) => ({
                algoId: order.algoId,
                instId: order.instId,
            }))
        )

        for (const ack of data) {
            assertAckSuccess(ack.sCode, ack.sMsg, "OKX algo cancellation")
        }

        return data
    }

    async getAlgoOrdersPending(
        instType: "SWAP" = "SWAP",
        instId?: string,
        ordType?: OKXAlgoOrderType
    ): Promise<OKXAlgoOrder[]> {
        if (!ordType) {
            const [conditional, oco] = await Promise.all([
                this.getAlgoOrdersPending(instType, instId, "conditional"),
                this.getAlgoOrdersPending(instType, instId, "oco"),
            ])
            return [...conditional, ...oco]
        }

        return await this.privateRequest<OKXAlgoOrder>(
            "GET",
            "/api/v5/trade/orders-algo-pending",
            {
                ordType,
                instType,
                instId,
            }
        )
    }

    private async publicRequest<T>(
        method: "GET" | "POST",
        path: string,
        params?: Record<string, string | number | boolean | undefined>
    ): Promise<T[]> {
        return await this.requestWithRetry<T>({
            method,
            path,
            params,
            authenticated: false,
        })
    }

    private async privateRequest<T>(
        method: "GET" | "POST",
        path: string,
        params?: Record<string, string | number | boolean | undefined>,
        body?: Record<string, unknown> | Record<string, unknown>[]
    ): Promise<T[]> {
        return await this.requestWithRetry<T>({
            method,
            path,
            params,
            body,
            authenticated: true,
        })
    }

    private async requestWithRetry<T>(config: {
        method: "GET" | "POST"
        path: string
        params?: Record<string, string | number | boolean | undefined>
        body?: Record<string, unknown> | Record<string, unknown>[]
        authenticated: boolean
    }): Promise<T[]> {
        let lastError: unknown

        for (let attempt = 0; attempt <= OKX_MAX_RETRIES; attempt++) {
            try {
                return await this.requestOnce<T>(config)
            } catch (error) {
                lastError = error

                const retryable = isRetryableRequestError(error)
                if (!retryable || attempt === OKX_MAX_RETRIES) {
                    throw error
                }

                await delay(OKX_BASE_DELAY_MS * Math.pow(2, attempt))
            }
        }

        throw lastError
    }

    private async requestOnce<T>(config: {
        method: "GET" | "POST"
        path: string
        params?: Record<string, string | number | boolean | undefined>
        body?: Record<string, unknown> | Record<string, unknown>[]
        authenticated: boolean
    }): Promise<T[]> {
        const query = buildQuery(config.params)
        const requestPath = query ? `${config.path}?${query}` : config.path
        const url = `${this.baseUrl}${requestPath}`
        const body = config.method === "POST"
            ? serializeBody(config.body)
            : ""
        const timestamp = new Date().toISOString()
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        }

        if (config.authenticated) {
            headers["OK-ACCESS-KEY"] = this.apiKey
            headers["OK-ACCESS-PASSPHRASE"] = this.apiPassphrase
            headers["OK-ACCESS-TIMESTAMP"] = timestamp
            headers["OK-ACCESS-SIGN"] = this.sign(
                timestamp,
                config.method,
                requestPath,
                body
            )
        }

        if (this.demoTrading) {
            headers["x-simulated-trading"] = "1"
        }

        const response = await fetchWithTimeout(
            url,
            {
                method: config.method,
                headers,
                body: body.length > 0 ? body : undefined,
            },
            OKX_REQUEST_TIMEOUT_MS,
            `OKX request ${config.path}`
        )

        return await parseOKXResponse<T>(response, config.path)
    }

    private sign(
        timestamp: string,
        method: string,
        requestPath: string,
        body: string
    ): string {
        return createHmac("sha256", this.apiSecret)
            .update(`${timestamp}${method}${requestPath}${body}`)
            .digest("base64")
    }
}

function assertAckSuccess(
    code: string,
    message: string,
    operation: string,
    details: Record<string, unknown> = {}
): void {
    if (code === "0") {
        return
    }

    throw new OKXApiError(
        message || `${operation} failed`,
        200,
        code,
        {
            operation,
            ...details,
        }
    )
}

async function parseOKXResponse<T>(
    response: Response,
    path: string
): Promise<T[]> {
    let payload: OKXResponseEnvelope<T> | undefined

    try {
        payload = await response.json() as OKXResponseEnvelope<T>
    } catch {
        payload = undefined
    }

    if (!response.ok) {
        const message = payload?.msg || `${response.status} ${response.statusText}`
        throw new OKXApiError(
            message,
            response.status,
            payload?.code,
            {
                path,
            }
        )
    }

    if (!payload) {
        throw new OKXApiError(
            `Empty response from ${path}`,
            response.status,
            undefined,
            {
                path,
            }
        )
    }

    if (payload.code !== "0") {
        throw new OKXApiError(
            payload.msg || `OKX request failed for ${path}`,
            response.status,
            payload.code,
            {
                path,
            }
        )
    }

    return payload.data
}

function buildQuery(
    params?: Record<string, string | number | boolean | undefined>
): string {
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

function serializeBody(
    body?: Record<string, unknown> | Record<string, unknown>[]
): string {
    if (!body) {
        return ""
    }

    if (Array.isArray(body)) {
        return JSON.stringify(
            body.map((entry) => stripUndefined(entry))
        )
    }

    return JSON.stringify(stripUndefined(body))
}

function stripUndefined(
    value: Record<string, unknown>
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
    )
}

function requireFirst<T>(items: T[], label: string): T {
    const item = items[0]
    if (item === undefined) {
        throw new Error(`${label} response was empty`)
    }

    return item
}

function normalizeBaseUrl(value?: string): string {
    return (value ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

function isRetryableRequestError(error: unknown): boolean {
    if (error instanceof OKXApiError) {
        return error.retryable
    }

    const detail = getExecutionErrorDetail(error)
    if (!detail) {
        return false
    }

    return detail.source === "network" || detail.source === "timeout" || detail.retryable === true
}

function isRetryableOKXError(
    status: number,
    code?: string
): boolean {
    if (status >= 500 || status === 429) {
        return true
    }

    if (!code) {
        return false
    }

    return code === "50011" || code === "50040" || code.startsWith("58")
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
