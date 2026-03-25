import { retryWithBackoff, type ExecutionResult, type OrderIntent } from "@valiq-trading/core"

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
    qty?: string
    filled_qty?: string
    filled_avg_price?: string | null
    limit_price?: string | null
    stop_price?: string | null
    legs?: Array<{
        symbol: string
        side: "buy" | "sell"
        ratio_qty?: string | number
    }>
}

const DEFAULT_BASE_URL = "https://paper-api.alpaca.markets"

export class AlpacaClient {
    private readonly apiKey: string
    private readonly secretKey: string
    private readonly accountId: string
    private readonly baseUrl: string

    constructor(credentials: AlpacaCredentials) {
        this.apiKey = credentials.apiKey
        this.secretKey = credentials.secretKey
        this.accountId = credentials.accountId
        this.baseUrl = credentials.baseUrl ?? DEFAULT_BASE_URL
    }

    async getAccount(): Promise<AlpacaAccountResponse> {
        return await this.request<AlpacaAccountResponse>("/v2/account")
    }

    async getPositions(): Promise<AlpacaPositionResponse[]> {
        return await this.request<AlpacaPositionResponse[]>("/v2/positions")
    }

    async createOrder(intent: OrderIntent): Promise<ExecutionResult> {
        if (!intent.legs || intent.legs.length < 2) {
            throw new Error("Alpaca options orders must be submitted as a multi-leg order")
        }

        const payload: Record<string, unknown> = {
            order_class: "mleg",
            side: intent.side,
            type: mapOrderType(intent.orderType),
            time_in_force: intent.timeInForce,
            qty: intent.quantity,
            symbol: intent.instrument,
            legs: intent.legs.map((leg) => ({
                symbol: leg.instrument,
                ratio_qty: leg.quantity,
                side: leg.side,
            })),
        }

        if (intent.limitPrice !== undefined) {
            payload.limit_price = intent.limitPrice
        }

        if (intent.stopPrice !== undefined) {
            payload.stop_price = intent.stopPrice
        }

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
            payload.stop_price = changes.stopPrice
        }
        if (changes.timeInForce !== undefined) {
            payload.time_in_force = changes.timeInForce
        }
        if (changes.orderType !== undefined) {
            payload.type = mapOrderType(changes.orderType)
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
            const response = await fetch(`${this.baseUrl}${path}`, {
                ...init,
                headers: {
                    "APCA-API-KEY-ID": this.apiKey,
                    "APCA-API-SECRET-KEY": this.secretKey,
                    "APCA-ACCOUNT-ID": this.accountId,
                    "Content-Type": "application/json",
                    ...init.headers,
                },
            })

            if (!response.ok) {
                const body = await response.text().catch(() => "")
                throw new Error(`Alpaca API error: ${response.status} ${response.statusText} ${body}`)
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
    return {
        orderId: order.id,
        status: mapOrderStatus(order.status),
        filledQuantity: Number(order.filled_qty ?? 0),
        fillPrice: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        timestamp: Date.now(),
        error: mapOrderStatus(order.status) === "rejected" ? order.status : undefined,
    }
}
