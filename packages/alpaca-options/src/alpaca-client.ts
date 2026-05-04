import {
    createExecutionError,
    createExecutionErrorDetail,
    fetchWithTimeout,
    retryWithBackoff,
    type ExecutionErrorDetail,
    type ExecutionResult,
    type OrderIntent,
} from "@valiq-trading/core"
import type {
    AlpacaAccountResponse,
    AlpacaClockResponse,
    AlpacaEquityQuote,
    AlpacaEquitySnapshot,
    AlpacaOptionChainParams,
    AlpacaOptionContract,
    AlpacaOptionContractsParams,
    AlpacaOptionSnapshotsResponse,
    AlpacaOrderResponse,
    AlpacaPositionResponse,
} from "./alpaca-client-types"
export type {
    AlpacaAccountResponse,
    AlpacaBar,
    AlpacaClockResponse,
    AlpacaEquityQuote,
    AlpacaEquitySnapshot,
    AlpacaEquityTrade,
    AlpacaOptionChainParams,
    AlpacaOptionContract,
    AlpacaOptionContractsParams,
    AlpacaOptionGreeks,
    AlpacaOptionQuote,
    AlpacaOptionSnapshot,
    AlpacaOptionSnapshotsResponse,
    AlpacaOptionTrade,
    AlpacaOrderResponse,
    AlpacaPositionResponse,
} from "./alpaca-client-types"
import {
    applyOptionChainQueryParams,
    normalizeClockResponse,
    normalizeEquityQuoteResponse,
    normalizeEquitySnapshotResponse,
    normalizeOptionContractsResponse,
    normalizeOptionSnapshotsResponse,
} from "./alpaca-market-data-mappers"
import {
    buildCreateOrderPayload,
    mapOrderResponse,
    resolveAlpacaMlegOrderSide,
    toSignedAlpacaMlegLimitPrice,
} from "./alpaca-order-mappers"
export { buildCreateOrderPayload } from "./alpaca-order-mappers"
import type { AlpacaRuntimeConfig } from "./runtime-config"

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

    async getClock(): Promise<AlpacaClockResponse> {
        const response = await this.request<unknown>("/v2/clock")
        return normalizeClockResponse(response)
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
            throw createExecutionError("pre_validation", "Alpaca options structures do not support stop price modifications", {
                code: "STOP_PRICE_UNSUPPORTED",
                retryable: false,
            })
        }

        if (changes.timeInForce !== undefined && changes.timeInForce !== "day") {
            throw createExecutionError("pre_validation", "Alpaca options structures only support day time in force", {
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
