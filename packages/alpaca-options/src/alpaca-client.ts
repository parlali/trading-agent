import {
    createExecutionError,
    createExecutionErrorDetail,
    fetchWithTimeout,
    formatExecutionError,
    retryWithBackoff,
    type ExecutionErrorDetail,
    type ExecutionResult,
    type OrderIntent,
} from "@valiq-trading/core"
import type { AlpacaRuntimeConfig } from "./runtime-config"

export interface AlpacaAccountResponse {
    id: string
    cash?: string
    equity: string
    buying_power: string
    regt_buying_power?: string
    initial_margin?: string
    maintenance_margin?: string
    unrealized_pl?: string
    last_equity?: string
    portfolio_value?: string
}

export interface AlpacaPositionResponse {
    asset_class?: string
    symbol: string
    qty: string
    side: "long" | "short"
    avg_entry_price: string
    current_price?: string
    unrealized_pl?: string
    cost_basis?: string
    market_value?: string
}

export interface AlpacaOrderResponse {
    id: string
    status: string
    order_class?: string
    side?: "buy" | "sell"
    submitted_at?: string
    updated_at?: string
    qty?: string
    filled_qty?: string
    filled_avg_price?: string | null
    limit_price?: string | null
    stop_price?: string | null
    legs?: Array<{
        symbol: string
        side: "buy" | "sell" | "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
        position_intent?: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
        ratio_qty?: string | number
    }>
}

export interface AlpacaOptionContract {
    symbol: string
    name?: string
    status?: string
    tradable?: boolean
    expirationDate?: string
    underlyingSymbol?: string
    optionType?: "call" | "put"
    strikePrice?: number
    style?: string
    size?: number
    openInterest?: number
    closePrice?: number
}

export interface AlpacaOptionContractsParams {
    underlyingSymbol: string
    expirationDate?: string
    expirationDateFrom?: string
    expirationDateTo?: string
    strikePriceGte?: number
    strikePriceLte?: number
    optionType?: "call" | "put"
    limit?: number
    pageToken?: string
}

export interface AlpacaOptionChainParams {
    expirationDate?: string
    expirationDateFrom?: string
    expirationDateTo?: string
    strikePriceGte?: number
    strikePriceLte?: number
    optionType?: "call" | "put"
    limit?: number
    pageToken?: string
}

export interface AlpacaOptionQuote {
    bidPrice?: number
    askPrice?: number
    bidSize?: number
    askSize?: number
    timestamp?: string
}

export interface AlpacaOptionTrade {
    price?: number
    size?: number
    timestamp?: string
}

export interface AlpacaOptionGreeks {
    delta?: number
    gamma?: number
    theta?: number
    vega?: number
    rho?: number
}

export interface AlpacaOptionSnapshot {
    symbol: string
    latestQuote?: AlpacaOptionQuote
    latestTrade?: AlpacaOptionTrade
    greeks?: AlpacaOptionGreeks
    impliedVolatility?: number
    openInterest?: number
}

export interface AlpacaOptionSnapshotsResponse {
    snapshots: Record<string, AlpacaOptionSnapshot>
    nextPageToken?: string
}

export interface AlpacaEquityQuote {
    symbol: string
    bidPrice?: number
    askPrice?: number
    bidSize?: number
    askSize?: number
    timestamp?: string
}

export interface AlpacaEquityTrade {
    price?: number
    size?: number
    timestamp?: string
}

export interface AlpacaBar {
    open?: number
    high?: number
    low?: number
    close?: number
    volume?: number
    timestamp?: string
}

export interface AlpacaEquitySnapshot {
    symbol: string
    latestTrade?: AlpacaEquityTrade
    latestQuote?: AlpacaEquityQuote
    minuteBar?: AlpacaBar
    dailyBar?: AlpacaBar
    prevDailyBar?: AlpacaBar
}

export class AlpacaApiError extends Error {
    readonly status: number
    readonly code?: string
    readonly retryable: boolean
    readonly executionError: ExecutionErrorDetail

    constructor(
        message: string,
        status: number,
        options: {
            code?: string
            retryable?: boolean
            details?: Record<string, unknown>
        } = {}
    ) {
        super(message)
        this.name = "AlpacaApiError"
        this.status = status
        this.code = options.code
        this.retryable = options.retryable ?? (status >= 500 || status === 429)
        this.executionError = createExecutionErrorDetail("venue", message, {
            code: options.code,
            retryable: this.retryable,
            details: {
                status,
                ...(options.details ?? {}),
            },
        })
    }
}

const ALPACA_REQUEST_TIMEOUT_MS = 30_000

export class AlpacaClient {
    private readonly apiKey: string
    private readonly secretKey: string
    private readonly accountId: string
    private readonly tradingBaseUrl: string
    private readonly marketDataBaseUrl: string

    constructor(config: AlpacaRuntimeConfig) {
        this.apiKey = config.credentials.apiKey
        this.secretKey = config.credentials.secretKey
        this.accountId = config.credentials.accountId
        this.tradingBaseUrl = config.tradingBaseUrl
        this.marketDataBaseUrl = config.marketDataBaseUrl
    }

    async getAccount(): Promise<AlpacaAccountResponse> {
        return await this.request<AlpacaAccountResponse>("/v2/account")
    }

    async getPositions(): Promise<AlpacaPositionResponse[]> {
        return await this.request<AlpacaPositionResponse[]>("/v2/positions")
    }

    async getOpenOrders(): Promise<AlpacaOrderResponse[]> {
        return await this.request<AlpacaOrderResponse[]>("/v2/orders?status=open&nested=true&direction=desc&limit=500")
    }

    async getOptionContracts(
        params: AlpacaOptionContractsParams
    ): Promise<{ contracts: AlpacaOptionContract[]; nextPageToken?: string }> {
        const query = new URLSearchParams()
        query.set("underlying_symbols", params.underlyingSymbol.toUpperCase())
        applyOptionChainQueryParams(query, params)

        const response = await this.request<unknown>(
            `/v2/options/contracts?${query.toString()}`
        )

        return normalizeOptionContractsResponse(response)
    }

    async getOptionSnapshotsByUnderlying(
        underlyingSymbol: string,
        params: AlpacaOptionChainParams = {}
    ): Promise<AlpacaOptionSnapshotsResponse> {
        const query = new URLSearchParams()
        applyOptionChainQueryParams(query, params)

        const suffix = query.toString()
        const response = await this.dataRequest<unknown>(
            `/v1beta1/options/snapshots/${encodeURIComponent(underlyingSymbol.toUpperCase())}${suffix ? `?${suffix}` : ""}`
        )

        return normalizeOptionSnapshotsResponse(response)
    }

    async getOptionSnapshots(
        symbols: string[]
    ): Promise<AlpacaOptionSnapshotsResponse> {
        const normalizedSymbols = Array.from(
            new Set(
                symbols
                    .map((symbol) => symbol.trim().toUpperCase())
                    .filter(Boolean)
            )
        )

        if (normalizedSymbols.length === 0) {
            return {
                snapshots: {},
            }
        }

        const response = await this.dataRequest<unknown>(
            `/v1beta1/options/snapshots?symbols=${encodeURIComponent(normalizedSymbols.join(","))}`
        )

        return normalizeOptionSnapshotsResponse(response)
    }

    async getLatestEquityQuote(symbol: string): Promise<AlpacaEquityQuote> {
        const response = await this.dataRequest<unknown>(
            `/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/quotes/latest`
        )

        return normalizeEquityQuoteResponse(symbol, response)
    }

    async getEquitySnapshot(symbol: string): Promise<AlpacaEquitySnapshot> {
        const response = await this.dataRequest<unknown>(
            `/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/snapshot`
        )

        return normalizeEquitySnapshotResponse(symbol, response)
    }

    async createOrder(intent: OrderIntent): Promise<ExecutionResult> {
        const payload = buildCreateOrderPayload(intent)

        const response = await this.request<AlpacaOrderResponse>("/v2/orders", {
            method: "POST",
            body: JSON.stringify(payload),
        })

        return mapOrderResponse(response)
    }

    async getOrder(orderId: string): Promise<ExecutionResult> {
        const response = await this.request<AlpacaOrderResponse>(`/v2/orders/${orderId}`)
        return mapOrderResponse(response)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        await this.request(`/v2/orders/${orderId}`, {
            method: "DELETE",
        })

        return await this.getOrder(orderId)
    }

    async replaceOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        const payload: Record<string, unknown> = {}
        let existingOrder: AlpacaOrderResponse | null = null

        if (changes.quantity !== undefined) {
            payload.qty = changes.quantity
        }
        if (changes.limitPrice !== undefined) {
            existingOrder = await this.request<AlpacaOrderResponse>(`/v2/orders/${orderId}`)
            payload.limit_price = toSignedAlpacaMlegLimitPrice(
                changes.limitPrice,
                resolveAlpacaMlegOrderSide(existingOrder)
            )
        }

        if (changes.stopPrice !== undefined) {
            throw createExecutionError("pre_validation", "Alpaca iron condor orders do not support stop price modifications", {
                code: "STOP_PRICE_UNSUPPORTED",
                retryable: false,
            })
        }

        if (changes.timeInForce !== undefined && changes.timeInForce !== "day") {
            throw createExecutionError("pre_validation", "Alpaca iron condor orders only support day time in force", {
                code: "TIME_IN_FORCE_UNSUPPORTED",
                retryable: false,
            })
        }

        if (Object.keys(payload).length === 0) {
            throw createExecutionError("pre_validation", "No supported Alpaca order modifications were provided", {
                code: "NO_SUPPORTED_MODIFICATIONS",
                retryable: false,
            })
        }

        const response = await this.request<AlpacaOrderResponse>(`/v2/orders/${orderId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        })

        return mapOrderResponse(response)
    }

    private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
        return await this.requestAgainstBaseUrl<T>(this.tradingBaseUrl, path, init)
    }

    private async dataRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
        return await this.requestAgainstBaseUrl<T>(this.marketDataBaseUrl, path, init)
    }

    private async requestAgainstBaseUrl<T = unknown>(
        baseUrl: string,
        path: string,
        init: RequestInit = {}
    ): Promise<T> {
        return await retryWithBackoff(async () => {
            const response = await fetchWithTimeout(`${baseUrl}${path}`, {
                ...init,
                headers: {
                    "APCA-API-KEY-ID": this.apiKey,
                    "APCA-API-SECRET-KEY": this.secretKey,
                    "APCA-ACCOUNT-ID": this.accountId,
                    "Content-Type": "application/json",
                    ...init.headers,
                },
            }, ALPACA_REQUEST_TIMEOUT_MS, `Alpaca request ${path}`)

            if (!response.ok) {
                throw await toAlpacaApiError(response)
            }

            if (response.status === 204) {
                return {} as T
            }

            return await response.json() as T
        }, 3, 1000)
    }
}

function mapOrderType(orderType: OrderIntent["orderType"]): string {
    return orderType === "stop_limit" ? "stop_limit" : orderType
}

function mapOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "filled":
            return "filled"
        case "partially_filled":
            return "partially_filled"
        case "canceled":
        case "cancelled":
        case "pending_cancel":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
        case "suspended":
            return "rejected"
        default:
            return "pending"
    }
}

function mapOrderResponse(order: AlpacaOrderResponse): ExecutionResult {
    const status = mapOrderStatus(order.status)
    const quantity = order.qty ? Number(order.qty) : undefined
    const limitPrice = normalizeAlpacaMlegLimitPrice(
        order.limit_price ? Number(order.limit_price) : undefined,
        order
    )
    const intentUpdates: Partial<OrderIntent> = {}
    const errorDetail = status === "rejected"
        ? createExecutionErrorDetail("venue", order.status, {
            code: order.status.toUpperCase(),
            retryable: false,
            details: {
                orderId: order.id,
                status: order.status,
            },
        })
        : undefined

    if (quantity !== undefined) {
        intentUpdates.quantity = quantity
    }

    if (limitPrice !== undefined) {
        intentUpdates.limitPrice = limitPrice
    }

    return {
        orderId: order.id,
        status,
        filledQuantity: Number(order.filled_qty ?? 0),
        fillPrice: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        timestamp: resolveOrderTimestamp(order),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
        intentUpdates: Object.keys(intentUpdates).length > 0 ? intentUpdates : undefined,
    }
}

function applyOptionChainQueryParams(
    query: URLSearchParams,
    params: AlpacaOptionChainParams
): void {
    const expirationDateFrom = params.expirationDateFrom ?? params.expirationDate
    const expirationDateTo = params.expirationDateTo ?? params.expirationDate

    if (expirationDateFrom) {
        query.set("expiration_date_gte", expirationDateFrom)
    }

    if (expirationDateTo) {
        query.set("expiration_date_lte", expirationDateTo)
    }

    if (params.strikePriceGte !== undefined) {
        query.set("strike_price_gte", String(params.strikePriceGte))
    }

    if (params.strikePriceLte !== undefined) {
        query.set("strike_price_lte", String(params.strikePriceLte))
    }

    if (params.optionType) {
        query.set("type", params.optionType)
    }

    if (params.limit !== undefined) {
        query.set("limit", String(params.limit))
    }

    if (params.pageToken) {
        query.set("page_token", params.pageToken)
    }
}

function normalizeOptionContractsResponse(
    payload: unknown
): { contracts: AlpacaOptionContract[]; nextPageToken?: string } {
    const record = asRecord(payload)
    const rawContracts = asArray(record?.option_contracts ?? record?.contracts)

    return {
        contracts: rawContracts.filter(isRecord).map((contract) => normalizeOptionContract(contract)).filter(isDefined),
        nextPageToken: asOptionalString(record?.next_page_token ?? record?.nextPageToken),
    }
}

function normalizeOptionContract(payload: unknown): AlpacaOptionContract | null {
    const record = asRecord(payload)
    const symbol = asOptionalString(record?.symbol)

    if (!symbol) {
        return null
    }

    return {
        symbol,
        name: asOptionalString(record?.name),
        status: asOptionalString(record?.status),
        tradable: asOptionalBoolean(record?.tradable),
        expirationDate: asOptionalString(record?.expiration_date ?? record?.expirationDate),
        underlyingSymbol: asOptionalString(record?.underlying_symbol ?? record?.underlyingSymbol),
        optionType: normalizeOptionType(record?.type),
        strikePrice: asOptionalNumber(record?.strike_price ?? record?.strikePrice),
        style: asOptionalString(record?.style),
        size: asOptionalNumber(record?.size),
        openInterest: asOptionalNumber(record?.open_interest ?? record?.openInterest),
        closePrice: asOptionalNumber(record?.close_price ?? record?.closePrice),
    }
}

function normalizeOptionSnapshotsResponse(
    payload: unknown
): AlpacaOptionSnapshotsResponse {
    const record = asRecord(payload)
    const rawSnapshots = asRecord(record?.snapshots)
    const snapshots: Record<string, AlpacaOptionSnapshot> = {}

    const snapshotEntries = rawSnapshots
        ? Object.entries(rawSnapshots)
        : Object.entries(record ?? {}).filter(([, rawSnapshot]) => isRecord(rawSnapshot))

    for (const [symbol, rawSnapshot] of snapshotEntries) {
        const snapshot = normalizeOptionSnapshot(symbol, rawSnapshot)
        if (snapshot) {
            snapshots[snapshot.symbol] = snapshot
        }
    }

    return {
        snapshots,
        nextPageToken: asOptionalString(record?.next_page_token ?? record?.nextPageToken),
    }
}

function normalizeOptionSnapshot(
    fallbackSymbol: string,
    payload: unknown
): AlpacaOptionSnapshot | null {
    const record = asRecord(payload)
    const symbol = asOptionalString(record?.symbol) ?? fallbackSymbol

    if (!symbol) {
        return null
    }

    return {
        symbol,
        latestQuote: normalizeQuote(record?.latestQuote ?? record?.latest_quote),
        latestTrade: normalizeTrade(record?.latestTrade ?? record?.latest_trade),
        greeks: normalizeGreeks(record?.greeks),
        impliedVolatility: asOptionalNumber(record?.impliedVolatility ?? record?.implied_volatility),
        openInterest: asOptionalNumber(record?.openInterest ?? record?.open_interest),
    }
}

function normalizeEquityQuoteResponse(
    symbol: string,
    payload: unknown
): AlpacaEquityQuote {
    const record = asRecord(payload)
    const quote = asRecord(record?.quote) ?? record
    const normalizedQuote = normalizeQuote(quote)

    return {
        symbol: symbol.toUpperCase(),
        ...(normalizedQuote ?? {}),
    }
}

function normalizeEquitySnapshotResponse(
    symbol: string,
    payload: unknown
): AlpacaEquitySnapshot {
    const record = asRecord(payload)
    const latestQuote = normalizeQuote(record?.latestQuote ?? record?.latest_quote)

    return {
        symbol: symbol.toUpperCase(),
        latestTrade: normalizeTrade(record?.latestTrade ?? record?.latest_trade),
        latestQuote: latestQuote
            ? {
                symbol: symbol.toUpperCase(),
                ...latestQuote,
            }
            : undefined,
        minuteBar: normalizeBar(record?.minuteBar ?? record?.minute_bar),
        dailyBar: normalizeBar(record?.dailyBar ?? record?.daily_bar),
        prevDailyBar: normalizeBar(record?.prevDailyBar ?? record?.prev_daily_bar),
    }
}

function normalizeQuote(payload: unknown): AlpacaOptionQuote | undefined {
    const record = asRecord(payload)

    if (!record) {
        return undefined
    }

    return {
        bidPrice: asOptionalNumber(record.bp ?? record.bid_price ?? record.bidPrice),
        askPrice: asOptionalNumber(record.ap ?? record.ask_price ?? record.askPrice),
        bidSize: asOptionalNumber(record.bs ?? record.bid_size ?? record.bidSize),
        askSize: asOptionalNumber(record.as ?? record.ask_size ?? record.askSize),
        timestamp: asOptionalString(record.t ?? record.timestamp),
    }
}

function normalizeTrade(payload: unknown): AlpacaOptionTrade | undefined {
    const record = asRecord(payload)

    if (!record) {
        return undefined
    }

    return {
        price: asOptionalNumber(record.p ?? record.price),
        size: asOptionalNumber(record.s ?? record.size),
        timestamp: asOptionalString(record.t ?? record.timestamp),
    }
}

function normalizeGreeks(payload: unknown): AlpacaOptionGreeks | undefined {
    const record = asRecord(payload)

    if (!record) {
        return undefined
    }

    return {
        delta: asOptionalNumber(record.delta),
        gamma: asOptionalNumber(record.gamma),
        theta: asOptionalNumber(record.theta),
        vega: asOptionalNumber(record.vega),
        rho: asOptionalNumber(record.rho),
    }
}

function normalizeBar(payload: unknown): AlpacaBar | undefined {
    const record = asRecord(payload)

    if (!record) {
        return undefined
    }

    return {
        open: asOptionalNumber(record.o ?? record.open),
        high: asOptionalNumber(record.h ?? record.high),
        low: asOptionalNumber(record.l ?? record.low),
        close: asOptionalNumber(record.c ?? record.close),
        volume: asOptionalNumber(record.v ?? record.volume),
        timestamp: asOptionalString(record.t ?? record.timestamp),
    }
}

function normalizeOptionType(value: unknown): "call" | "put" | undefined {
    const normalized = asOptionalString(value)?.toLowerCase()

    if (normalized === "call" || normalized === "put") {
        return normalized
    }

    return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined
    }

    return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(asRecord(value))
}

function isDefined<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

function asOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined
}

function asOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

export function buildCreateOrderPayload(intent: OrderIntent): Record<string, unknown> {
    if (!intent.legs || intent.legs.length !== 4) {
        throw createExecutionError("pre_validation", "Alpaca options orders must be submitted as exactly 4 legs", {
            code: "INVALID_LEG_COUNT",
            retryable: false,
        })
    }

    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        throw createExecutionError("pre_validation", "Alpaca options orders require a positive integer structure quantity", {
            code: "INVALID_QUANTITY",
            retryable: false,
        })
    }

    if (intent.orderType !== "limit") {
        throw createExecutionError("pre_validation", "Alpaca options orders only support limit pricing", {
            code: "ORDER_TYPE_UNSUPPORTED",
            retryable: false,
        })
    }

    if (intent.timeInForce !== "day") {
        throw createExecutionError("pre_validation", "Alpaca options orders only support day time in force", {
            code: "TIME_IN_FORCE_UNSUPPORTED",
            retryable: false,
        })
    }

    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        throw createExecutionError("pre_validation", "Alpaca options orders require a positive limit price", {
            code: "INVALID_LIMIT_PRICE",
            retryable: false,
        })
    }

    if (intent.stopPrice !== undefined) {
        throw createExecutionError("pre_validation", "Alpaca options orders do not support stop prices", {
            code: "STOP_PRICE_UNSUPPORTED",
            retryable: false,
        })
    }

    if (intent.legs.some((leg) => !Number.isInteger(leg.quantity) || leg.quantity <= 0)) {
        throw createExecutionError("pre_validation", "Alpaca options orders require positive integer leg ratios", {
            code: "INVALID_LEG_RATIO",
            retryable: false,
        })
    }

    return {
        order_class: "mleg",
        type: mapOrderType(intent.orderType),
        time_in_force: intent.timeInForce,
        qty: intent.quantity,
        limit_price: toSignedAlpacaMlegLimitPrice(intent.limitPrice, intent.side),
        legs: intent.legs.map((leg) => ({
            symbol: leg.instrument,
            ratio_qty: leg.quantity,
            ...mapAlpacaLegSide(leg.side),
        })),
    }
}

function mapAlpacaLegSide(
    side: NonNullable<OrderIntent["legs"]>[number]["side"]
): {
    side: "buy" | "sell"
    position_intent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
} {
    switch (side) {
        case "buy_to_open":
        case "buy_to_close":
            return {
                side: "buy",
                position_intent: side,
            }
        case "sell_to_open":
        case "sell_to_close":
            return {
                side: "sell",
                position_intent: side,
            }
        default:
            throw createExecutionError("pre_validation", `Unsupported Alpaca leg side: ${String(side)}`, {
                code: "INVALID_LEG_SIDE",
                retryable: false,
            })
    }
}

function resolveOrderTimestamp(order: AlpacaOrderResponse): number {
    const rawTimestamp = order.updated_at ?? order.submitted_at
    const parsed = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
}

async function toAlpacaApiError(response: Response): Promise<AlpacaApiError> {
    let message = `${response.status} ${response.statusText}`
    let code: string | undefined
    let details: Record<string, unknown> | undefined

    try {
        const payload = await response.json() as Record<string, unknown>
        details = payload

        const payloadMessage = payload.message
        if (typeof payloadMessage === "string" && payloadMessage.trim()) {
            message = payloadMessage
        }

        const payloadCode = payload.code ?? payload.error_code
        if (typeof payloadCode === "string" || typeof payloadCode === "number") {
            code = String(payloadCode)
        }
    } catch {
        const body = await response.text().catch(() => "")
        if (body) {
            message = body
            details = { body }
        }
    }

    return new AlpacaApiError(message, response.status, {
        code,
        details,
    })
}

function toSignedAlpacaMlegLimitPrice(
    limitPrice: number,
    side: "buy" | "sell" | null
): number {
    const normalizedLimitPrice = roundPrice(Math.abs(limitPrice))

    if (side === "sell") {
        return -normalizedLimitPrice
    }

    if (side === "buy") {
        return normalizedLimitPrice
    }

    throw createExecutionError("pre_validation", "Could not determine Alpaca multi-leg order side for signed limit price conversion", {
        code: "ALPACA_MLEG_SIDE_UNKNOWN",
        retryable: false,
    })
}

function normalizeAlpacaMlegLimitPrice(
    limitPrice: number | undefined,
    order: Pick<AlpacaOrderResponse, "order_class" | "legs">
): number | undefined {
    if (limitPrice === undefined) {
        return undefined
    }

    if (!isAlpacaMlegOrder(order)) {
        return limitPrice
    }

    return roundPrice(Math.abs(limitPrice))
}

function resolveAlpacaMlegOrderSide(
    order: Pick<AlpacaOrderResponse, "order_class" | "side" | "limit_price" | "legs">
): "buy" | "sell" | null {
    if (!isAlpacaMlegOrder(order)) {
        return order.side ?? null
    }

    if (order.side === "buy" || order.side === "sell") {
        return order.side
    }

    const signedLimitPrice = asOptionalNumber(order.limit_price)
    if (signedLimitPrice !== undefined && signedLimitPrice !== 0) {
        return signedLimitPrice < 0 ? "sell" : "buy"
    }

    const positionIntents = (order.legs ?? [])
        .map((leg) => leg.position_intent)
        .filter((value): value is NonNullable<typeof value> => Boolean(value))

    if (positionIntents.length === 0) {
        return null
    }

    if (positionIntents.every((positionIntent) => positionIntent.endsWith("_open"))) {
        return "sell"
    }

    if (positionIntents.every((positionIntent) => positionIntent.endsWith("_close"))) {
        return "buy"
    }

    return null
}

function isAlpacaMlegOrder(
    order: Pick<AlpacaOrderResponse, "order_class" | "legs">
): boolean {
    return order.order_class === "mleg" || Boolean(order.legs && order.legs.length > 0)
}

function roundPrice(price: number): number {
    return Math.round(price * 100) / 100
}
