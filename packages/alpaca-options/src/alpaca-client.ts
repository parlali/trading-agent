import {
    createExecutionErrorDetail,
    fetchWithTimeout,
    formatExecutionError,
    retryWithBackoff,
    type ExecutionErrorDetail,
    type ExecutionResult,
    type OrderIntent,
} from "@valiq-trading/core"

export interface AlpacaCredentials {
    apiKey: string
    secretKey: string
    accountId: string
    baseUrl?: string
}

export interface AlpacaAccountResponse {
    id: string
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
        ratio_qty?: string | number
    }>
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
        this.retryable = options.retryable ?? status >= 500 || status === 429
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

const DEFAULT_BASE_URL = "https://paper-api.alpaca.markets"
const ALPACA_REQUEST_TIMEOUT_MS = 30_000

export class AlpacaClient {
    private readonly apiKey: string
    private readonly secretKey: string
    private readonly accountId: string
    private readonly baseUrl: string

    constructor(credentials: AlpacaCredentials) {
        this.apiKey = credentials.apiKey
        this.secretKey = credentials.secretKey
        this.accountId = credentials.accountId
        this.baseUrl = normalizeBaseUrl(credentials.baseUrl)
    }

    async getAccount(): Promise<AlpacaAccountResponse> {
        return await this.request<AlpacaAccountResponse>("/v2/account")
    }

    async getPositions(): Promise<AlpacaPositionResponse[]> {
        return await this.request<AlpacaPositionResponse[]>("/v2/positions")
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

        if (changes.quantity !== undefined) {
            payload.qty = changes.quantity
        }
        if (changes.limitPrice !== undefined) {
            payload.limit_price = changes.limitPrice
        }

        if (changes.stopPrice !== undefined) {
            throw new Error("Alpaca iron condor orders do not support stop price modifications")
        }

        if (changes.timeInForce !== undefined && changes.timeInForce !== "day") {
            throw new Error("Alpaca iron condor orders only support day time in force")
        }

        if (Object.keys(payload).length === 0) {
            throw new Error("No supported Alpaca order modifications were provided")
        }

        const response = await this.request<AlpacaOrderResponse>(`/v2/orders/${orderId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        })

        return mapOrderResponse(response)
    }

    private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
        return await retryWithBackoff(async () => {
            const response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
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
    const limitPrice = order.limit_price ? Number(order.limit_price) : undefined
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

function normalizeBaseUrl(baseUrl?: string): string {
    const resolved = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    return resolved.endsWith("/v2") ? resolved.slice(0, -3) : resolved
}

function buildCreateOrderPayload(intent: OrderIntent): Record<string, unknown> {
    if (!intent.legs || intent.legs.length !== 4) {
        throw new Error("Alpaca options orders must be submitted as exactly 4 legs")
    }

    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        throw new Error("Alpaca options orders require a positive integer structure quantity")
    }

    if (intent.orderType !== "limit") {
        throw new Error("Alpaca options orders only support limit pricing")
    }

    if (intent.timeInForce !== "day") {
        throw new Error("Alpaca options orders only support day time in force")
    }

    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        throw new Error("Alpaca options orders require a positive limit price")
    }

    if (intent.stopPrice !== undefined) {
        throw new Error("Alpaca options orders do not support stop prices")
    }

    if (intent.legs.some((leg) => !Number.isInteger(leg.quantity) || leg.quantity <= 0)) {
        throw new Error("Alpaca options orders require positive integer leg ratios")
    }

    return {
        order_class: "mleg",
        type: mapOrderType(intent.orderType),
        time_in_force: intent.timeInForce,
        qty: intent.quantity,
        limit_price: intent.limitPrice,
        legs: intent.legs.map((leg) => ({
            symbol: leg.instrument,
            ratio_qty: leg.quantity,
            side: leg.side,
        })),
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
