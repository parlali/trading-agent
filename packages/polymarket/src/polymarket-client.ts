import { createHmac } from "crypto"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import {
    createExecutionError,
    createExecutionErrorDetail,
    fetchWithTimeout,
    type ExecutionErrorDetail,
} from "@valiq-trading/core"
import type {
    CreateOrderParams,
    PaginatedResponse,
    PolymarketBalanceAllowance,
    PolymarketCredentials,
    PolymarketCurrentPosition,
    PolymarketMarket,
    PolymarketOpenOrder,
    PolymarketOrderBook,
    PolymarketSignatureType,
    PolymarketTrade,
    PreparedPolymarketOrder,
    PostOrderResponse,
} from "./polymarket-client-types"
export type {
    CreateOrderParams,
    PolymarketBalanceAllowance,
    PolymarketCredentials,
    PolymarketCurrentPosition,
    PolymarketMarket,
    PolymarketOpenOrder,
    PolymarketOrderBook,
    PolymarketSignatureType,
    PolymarketTrade,
    PreparedPolymarketOrder,
    PostOrderResponse,
} from "./polymarket-client-types"
import {
    clampGammaEventLimit,
    collectGammaMarkets,
    mapGammaMarket,
    mapRawMarket,
    toSlugCandidate,
    type GammaSearchResponse,
    type RawGammaEvent,
    type RawGammaMarket,
    type RawMarket,
} from "./polymarket-market-mappers"
import {
    AMOUNT_MULTIPLIER,
    CTF_EXCHANGE,
    NEG_RISK_CTF_EXCHANGE,
    ORDER_EIP712_TYPES,
    ZERO_ADDRESS,
    calculateOrderAmounts,
    derivePolymarketSalt,
    fingerprintPolymarketSignedOrder,
    roundToTickSize,
} from "./polymarket-order-signing"

const DEFAULT_HOST = "https://clob.polymarket.com"
const DEFAULT_GAMMA_HOST = "https://gamma-api.polymarket.com"
const DEFAULT_DATA_HOST = "https://data-api.polymarket.com"
const DEFAULT_CHAIN_ID = 137
const POLYMARKET_REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class PolymarketApiError extends Error {
    readonly status: number
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
        this.name = "PolymarketApiError"
        this.status = status
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PolymarketClient {
    private readonly account: PrivateKeyAccount
    private readonly address: `0x${string}`
    private readonly apiKey: string
    private readonly apiSecret: string
    private readonly apiPassphrase: string
    private readonly host: string
    private readonly gammaHost: string
    private readonly dataHost: string
    private readonly chainId: number
    private readonly signatureType: PolymarketSignatureType
    private readonly funderAddress: `0x${string}`

    // Per-token metadata caches (TTL: 5 minutes)
    private tickSizeCache = new Map<string, { value: string; fetchedAt: number }>()
    private negRiskCache = new Map<string, { value: boolean; fetchedAt: number }>()
    private feeRateCache = new Map<string, { value: number; fetchedAt: number }>()
    private readonly CACHE_TTL_MS = 300_000

    constructor(credentials: PolymarketCredentials) {
        const pk = credentials.privateKey.startsWith("0x")
            ? credentials.privateKey as `0x${string}`
            : `0x${credentials.privateKey}` as `0x${string}`
        this.account = privateKeyToAccount(pk)
        this.address = this.account.address
        this.apiKey = credentials.apiKey
        this.apiSecret = credentials.apiSecret
        this.apiPassphrase = credentials.apiPassphrase
        this.host = (credentials.host ?? DEFAULT_HOST).replace(/\/+$/, "")
        this.gammaHost = (credentials.gammaHost ?? DEFAULT_GAMMA_HOST).replace(/\/+$/, "")
        this.dataHost = (credentials.dataHost ?? DEFAULT_DATA_HOST).replace(/\/+$/, "")
        this.chainId = credentials.chainId ?? DEFAULT_CHAIN_ID
        this.signatureType = 1

        const normalizedFunder = credentials.funderAddress.trim()
        if (!normalizedFunder) {
            throw new Error("Polymarket funderAddress is required")
        }
        if (!normalizedFunder.startsWith("0x")) {
            throw new Error("Polymarket funderAddress must be a 0x-prefixed address")
        }

        this.funderAddress = normalizedFunder as `0x${string}`
    }

    getAddress(): string {
        return this.address
    }

    getFunderAddress(): string {
        return this.funderAddress
    }

    getSignatureType(): PolymarketSignatureType {
        return this.signatureType
    }

    // -----------------------------------------------------------------------
    // Market discovery (L0 — no auth required)
    // -----------------------------------------------------------------------

    async getMarkets(params?: {
        nextCursor?: string
        limit?: number
        active?: boolean
    }): Promise<PaginatedResponse<PolymarketMarket>> {
        const query = new URLSearchParams()
        if (params?.nextCursor) query.set("next_cursor", params.nextCursor)
        if (params?.limit) query.set("limit", String(params.limit))
        if (params?.active !== undefined) query.set("active", String(params.active))

        const raw = await this.requestPublic<PaginatedResponse<RawMarket>>(
            `/markets${query.toString() ? `?${query}` : ""}`
        )

        return {
            ...raw,
            data: raw.data.map(mapRawMarket),
        }
    }

    async getAllActiveMarkets(): Promise<PolymarketMarket[]> {
        const all: PolymarketMarket[] = []
        let cursor: string | undefined

        do {
            const page = await this.getMarkets({ nextCursor: cursor, active: true, limit: 100 })
            all.push(...page.data)
            cursor = page.next_cursor === "LTE=" ? undefined : page.next_cursor
        } while (cursor)

        return all
    }

    async getTopLiquidMarketsForCategory(
        category: string,
        limit: number = 10
    ): Promise<PolymarketMarket[]> {
        const normalizedCategory = category.trim().toLowerCase()
        if (!normalizedCategory) {
            return []
        }

        const eventLimit = clampGammaEventLimit(limit * 3)
        const query = new URLSearchParams()
        query.set("tag_slug", normalizedCategory)
        query.set("active", "true")
        query.set("closed", "false")
        query.set("archived", "false")
        query.set("order", "liquidity")
        query.set("limit", String(eventLimit))

        const events = await this.requestGamma<RawGammaEvent[]>(
            `/events?${query.toString()}`
        )

        return collectGammaMarkets(events, normalizedCategory).slice(0, limit)
    }

    async getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
        const normalizedSlug = toSlugCandidate(slug) ?? slug.trim()
        if (!normalizedSlug) {
            return null
        }

        const params = new URLSearchParams()
        params.set("slug", normalizedSlug)
        params.set("active", "true")
        params.set("closed", "false")
        params.set("archived", "false")
        params.set("limit", "1")

        const markets = await this.requestGammaOrNotFound<RawGammaMarket[]>(
            `/markets?${params.toString()}`
        ) ?? []
        const mapped = markets
            .map((market) => mapGammaMarket({}, market))
            .filter((market): market is PolymarketMarket => market !== null)

        if (mapped[0]) {
            return mapped[0]
        }

        const events = await this.requestGammaOrNotFound<RawGammaEvent[]>(
            `/events?${params.toString()}`
        ) ?? []
        return collectGammaMarkets(events)[0] ?? null
    }

    async searchMarkets(query: string, limit: number = 10): Promise<PolymarketMarket[]> {
        const normalizedQuery = query.trim()
        if (!normalizedQuery) {
            return []
        }

        const eventLimit = clampGammaEventLimit(limit * 3)
        const params = new URLSearchParams()
        params.set("q", normalizedQuery)
        params.set("limit_per_type", String(eventLimit))
        params.set("page", "1")
        params.set("search_tags", "false")
        params.set("search_profiles", "false")
        params.set("optimized", "true")

        const response = await this.requestGammaOrNotFound<GammaSearchResponse>(
            `/public-search?${params.toString()}`
        )
        if (!response) {
            const slugCandidate = toSlugCandidate(normalizedQuery)
            if (!slugCandidate) {
                return []
            }

            const direct = await this.getMarketBySlug(slugCandidate)
            return direct ? [direct] : []
        }

        const markets = collectGammaMarkets(response.events).slice(0, limit)
        if (markets.length > 0) {
            return markets
        }

        const slugCandidate = toSlugCandidate(normalizedQuery)
        if (!slugCandidate) {
            return []
        }

        const direct = await this.getMarketBySlug(slugCandidate)
        return direct ? [direct] : []
    }

    async getMarket(conditionId: string): Promise<PolymarketMarket> {
        const raw = await this.requestPublic<RawMarket>(`/market/${conditionId}`)
        return mapRawMarket(raw)
    }

    async getOrderBook(tokenId: string): Promise<PolymarketOrderBook> {
        return this.requestPublic<PolymarketOrderBook>(`/book?token_id=${tokenId}`)
    }

    async getMidpoint(tokenId: string): Promise<number> {
        const resp = await this.requestPublic<{ mid: string }>(`/midpoint?token_id=${tokenId}`)
        return Number(resp.mid)
    }

    async getPrice(tokenId: string, side: "buy" | "sell"): Promise<number> {
        const sideParam = side.toUpperCase()
        const resp = await this.requestPublic<{ price: string }>(`/price?token_id=${tokenId}&side=${sideParam}`)
        return Number(resp.price)
    }

    async getSpread(tokenId: string): Promise<{ bid: number; ask: number; spread: number }> {
        const resp = await this.requestPublic<{ bid: string; ask: string; spread: string }>(
            `/spread?token_id=${tokenId}`
        )
        return {
            bid: Number(resp.bid),
            ask: Number(resp.ask),
            spread: Number(resp.spread),
        }
    }

    async getTickSize(tokenId: string): Promise<string> {
        const cached = this.tickSizeCache.get(tokenId)
        if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
            return cached.value
        }

        const resp = await this.requestPublic<{ minimum_tick_size: string }>(
            `/tick-size?token_id=${tokenId}`
        )
        this.tickSizeCache.set(tokenId, { value: resp.minimum_tick_size, fetchedAt: Date.now() })
        return resp.minimum_tick_size
    }

    async getNegRisk(tokenId: string): Promise<boolean> {
        const cached = this.negRiskCache.get(tokenId)
        if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
            return cached.value
        }

        const resp = await this.requestPublic<{ neg_risk: boolean }>(`/neg-risk?token_id=${tokenId}`)
        this.negRiskCache.set(tokenId, { value: resp.neg_risk, fetchedAt: Date.now() })
        return resp.neg_risk
    }

    async getFeeRateBps(tokenId: string): Promise<number> {
        const cached = this.feeRateCache.get(tokenId)
        if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
            return cached.value
        }

        const resp = await this.requestPublic<{ fee_rate_bps: string }>(
            `/fee-rate?token_id=${tokenId}&sig_type=${this.signatureType}`
        )
        const value = Number(resp.fee_rate_bps)
        this.feeRateCache.set(tokenId, { value, fetchedAt: Date.now() })
        return value
    }

    // -----------------------------------------------------------------------
    // Trading (L2 — HMAC auth required)
    // -----------------------------------------------------------------------

    async prepareOrder(params: CreateOrderParams): Promise<PreparedPolymarketOrder> {
        const tickSize = await this.getTickSize(params.tokenId)
        const negRisk = params.negRisk ?? await this.getNegRisk(params.tokenId)
        const feeRateBps = await this.getFeeRateBps(params.tokenId)
        const maker = this.funderAddress

        const price = roundToTickSize(params.price, tickSize)
        const { makerAmount, takerAmount } = calculateOrderAmounts(
            params.side,
            params.size,
            price
        )

        const saltPayload = {
            tokenId: params.tokenId,
            side: params.side,
            size: params.size,
            price,
            orderType: params.orderType,
            expiration: params.expiration ?? 0,
            negRisk,
        }
        const salt = derivePolymarketSalt(params.canonicalOrderId, saltPayload)
        const sideEnum = params.side === "buy" ? 0 : 1
        const expiration = params.expiration ?? 0

        const exchangeAddress = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE

        const orderMessage = {
            salt,
            maker,
            signer: this.address,
            taker: ZERO_ADDRESS,
            tokenId: BigInt(params.tokenId),
            makerAmount,
            takerAmount,
            expiration: BigInt(expiration),
            nonce: BigInt(0),
            feeRateBps: BigInt(feeRateBps),
            side: sideEnum,
            signatureType: this.signatureType,
        }

        const signature = await this.account.signTypedData({
            domain: {
                name: "Polymarket CTF Exchange",
                version: "1",
                chainId: this.chainId,
                verifyingContract: exchangeAddress,
            },
            types: ORDER_EIP712_TYPES,
            primaryType: "Order",
            message: orderMessage,
        })

        const orderBody = {
            order: {
                salt: salt.toString(),
                maker,
                signer: this.address,
                taker: ZERO_ADDRESS,
                tokenId: params.tokenId,
                makerAmount: makerAmount.toString(),
                takerAmount: takerAmount.toString(),
                expiration: String(expiration),
                nonce: "0",
                feeRateBps: String(feeRateBps),
                side: sideEnum,
                signatureType: this.signatureType,
                signature,
            },
            owner: maker,
            orderType: params.orderType,
        }
        const signedOrderFingerprint = fingerprintPolymarketSignedOrder(orderBody.order)
        const signedOrderMetadata = {
            salt: orderBody.order.salt,
            maker,
            signer: this.address,
            tokenId: params.tokenId,
            side: params.side,
            size: params.size,
            price,
            orderType: params.orderType,
            negRisk,
            feeRateBps,
            makerAmount: orderBody.order.makerAmount,
            takerAmount: orderBody.order.takerAmount,
            expiration: orderBody.order.expiration,
            nonce: orderBody.order.nonce,
            signatureType: orderBody.order.signatureType,
            signedOrderFingerprint,
        }

        return {
            orderBody,
            signedOrderFingerprint,
            signedOrderMetadata,
        }
    }

    async createOrder(params: CreateOrderParams): Promise<PostOrderResponse> {
        const prepared = await this.prepareOrder(params)
        return await this.postPreparedOrder(prepared)
    }

    async postPreparedOrder(prepared: PreparedPolymarketOrder): Promise<PostOrderResponse> {
        const response = await this.requestAuthenticated<PostOrderResponse>(
            "POST",
            "/order",
            prepared.orderBody,
            undefined,
            {
                retry: false,
            }
        )

        if (!response) {
            throw createExecutionError("venue", "Polymarket order returned empty response", {
                code: "EMPTY_RESPONSE",
                retryable: true,
                details: {
                    signedOrderFingerprint: prepared.signedOrderFingerprint,
                },
            })
        }

        if (!response.success) {
            throw createExecutionError("venue", response.errorMsg || "Polymarket order rejected", {
                code: response.status || "ORDER_REJECTED",
                retryable: false,
                details: {
                    signedOrderFingerprint: prepared.signedOrderFingerprint,
                    signedOrderMetadata: prepared.signedOrderMetadata,
                    response,
                },
            })
        }

        return {
            ...response,
            signedOrderFingerprint: prepared.signedOrderFingerprint,
            signedOrderMetadata: prepared.signedOrderMetadata,
        }
    }

    async getOrder(orderId: string): Promise<PolymarketOpenOrder> {
        const response = await this.requestAuthenticated<PolymarketOpenOrder>("GET", `/data/order/${orderId}`)
        if (!response) {
            throw createExecutionError("venue", `Order ${orderId} not found`, {
                code: "ORDER_NOT_FOUND",
                retryable: false,
                details: {
                    orderId,
                },
            })
        }
        return response
    }

    async getOpenOrders(params?: {
        market?: string
        assetId?: string
    }): Promise<PolymarketOpenOrder[]> {
        const response = await this.requestAuthenticated<PolymarketOpenOrder[]>("GET", "/data/orders", undefined, {
            market: params?.market,
            asset_id: params?.assetId,
        })
        return Array.isArray(response) ? response : []
    }

    async cancelOrder(orderId: string): Promise<void> {
        await this.requestAuthenticated("DELETE", "/order", { orderID: orderId }, undefined, {
            retry: false,
        })
    }

    async cancelOrders(orderIds: string[]): Promise<void> {
        await this.requestAuthenticated("DELETE", "/orders", orderIds, undefined, {
            retry: false,
        })
    }

    async cancelAll(): Promise<void> {
        await this.requestAuthenticated("DELETE", "/cancel-all", undefined, undefined, {
            retry: false,
        })
    }

    async getTrades(params?: {
        market?: string
        assetId?: string
        before?: string
        after?: string
    }): Promise<PolymarketTrade[]> {
        const allTrades: PolymarketTrade[] = []
        let cursor: string | undefined

        do {
            const response = await this.requestAuthenticated<
                PolymarketTrade[] | PaginatedResponse<PolymarketTrade>
            >("GET", "/data/trades", undefined, {
                market: params?.market,
                asset_id: params?.assetId,
                before: params?.before,
                after: params?.after,
                next_cursor: cursor,
            })

            if (Array.isArray(response)) {
                allTrades.push(...response)
                cursor = undefined
            } else if (response && "data" in response && Array.isArray(response.data)) {
                allTrades.push(...response.data)
                cursor = response.next_cursor === "LTE=" ? undefined : response.next_cursor
            } else {
                cursor = undefined
            }
        } while (cursor)

        return allTrades
    }

    async getCurrentPositions(params?: {
        user?: string
        sizeThreshold?: number
    }): Promise<PolymarketCurrentPosition[]> {
        const query = new URLSearchParams()
        query.set("user", params?.user ?? this.funderAddress)
        if (params?.sizeThreshold !== undefined) {
            query.set("sizeThreshold", String(params.sizeThreshold))
        }

        return await this.requestData<PolymarketCurrentPosition[]>(
            `/positions?${query.toString()}`
        )
    }

    /** Get USDC balance (converted from raw 6-decimal integer to USD) */
    async getBalance(): Promise<number> {
        const balance = await this.getBalanceAllowance({
            assetType: "COLLATERAL",
        })
        if (!balance?.balance) return 0
        return Number(balance.balance) / AMOUNT_MULTIPLIER
    }

    /** Get conditional token balance for a specific token (converted from raw 6-decimal integer) */
    async getTokenBalance(tokenId: string): Promise<number> {
        const balance = await this.getBalanceAllowance({
            assetType: "CONDITIONAL",
            tokenId,
        })
        if (!balance?.balance) return 0
        return Number(balance.balance) / AMOUNT_MULTIPLIER
    }

    async getBalanceAllowance(params: {
        assetType: "COLLATERAL" | "CONDITIONAL"
        tokenId?: string
    }): Promise<PolymarketBalanceAllowance | undefined> {
        return this.requestAuthenticated<PolymarketBalanceAllowance>(
            "GET",
            "/balance-allowance",
            undefined,
            {
                asset_type: params.assetType,
                token_id: params.tokenId,
                signature_type: this.signatureType,
            }
        )
    }

    // -----------------------------------------------------------------------
    // HTTP layer
    // -----------------------------------------------------------------------

    private async requestPublic<T>(path: string): Promise<T> {
        return await this.requestPublicAgainstBaseUrl(this.host, path)
    }

    private async requestGamma<T>(path: string): Promise<T> {
        return await this.requestPublicAgainstBaseUrl(this.gammaHost, path)
    }

    private async requestGammaOrNotFound<T>(path: string): Promise<T | null> {
        try {
            return await this.requestGamma<T>(path)
        } catch (error) {
            if (error instanceof PolymarketApiError && error.status === 404) {
                return null
            }

            throw error
        }
    }

    private async requestData<T>(path: string): Promise<T> {
        return await this.requestPublicAgainstBaseUrl(this.dataHost, path)
    }

    private async requestPublicAgainstBaseUrl<T>(
        baseUrl: string,
        path: string
    ): Promise<T> {
        return await this.withPolymarketRetry(async () => {
            const response = await fetchWithTimeout(`${baseUrl}${path}`, {
                headers: { "Content-Type": "application/json" },
            }, POLYMARKET_REQUEST_TIMEOUT_MS, `Polymarket request ${path}`)

            if (!response.ok) {
                throw await toPolymarketApiError(response, path)
            }

            return (await response.json()) as T
        })
    }

    private async requestAuthenticated<T>(
        method: string,
        path: string,
        body?: unknown,
        query?: Record<string, string | number | boolean | undefined>,
        options: { retry?: boolean } = {}
    ): Promise<T | undefined> {
        const execute = async () => {
            const bodyString = body ? JSON.stringify(body) : ""
            const headers = this.buildL2Headers(method, path, bodyString)
            const url = appendQueryParams(`${this.host}${path}`, query)

            const init: RequestInit = {
                method,
                headers: {
                    ...headers,
                    "Content-Type": "application/json",
                },
            }

            if (body && (method === "POST" || method === "PUT" || method === "DELETE")) {
                init.body = bodyString
            }

            const response = await fetchWithTimeout(
                url,
                init,
                POLYMARKET_REQUEST_TIMEOUT_MS,
                `Polymarket authenticated request ${path}`
            )

            if (!response.ok) {
                throw await toPolymarketApiError(response, path)
            }

            if (response.status === 204) {
                return undefined
            }

            return (await response.json()) as T
        }

        if (options.retry === false) {
            return await execute()
        }

        return await this.withPolymarketRetry(execute)
    }

    private async withPolymarketRetry<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: unknown
        for (let attempt = 0; attempt <= 3; attempt++) {
            try {
                return await operation()
            } catch (error) {
                lastError = error
                if (error instanceof PolymarketApiError && !error.retryable) {
                    throw error
                }

                if (attempt < 3) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
                }
            }
        }

        throw lastError
    }

    private buildL2Headers(
        method: string,
        requestPath: string,
        body: string = ""
    ): Record<string, string> {
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const message = timestamp + method + requestPath + body
        const hmacKey = Buffer.from(normalizeBase64(this.apiSecret), "base64")
        const signature = toUrlSafeBase64(
            createHmac("sha256", hmacKey).update(message).digest("base64")
        )

        return {
            POLY_ADDRESS: this.address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: timestamp,
            POLY_API_KEY: this.apiKey,
            POLY_PASSPHRASE: this.apiPassphrase,
        }
    }
}

// ---------------------------------------------------------------------------
// Raw API response types (internal)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function toPolymarketApiError(response: Response, path: string): Promise<PolymarketApiError> {
    let message = `${response.status} ${response.statusText}`
    let code: string | undefined
    let details: Record<string, unknown> | undefined

    try {
        const payload = await response.json() as Record<string, unknown>
        details = payload

        const payloadMessage = payload.errorMsg ?? payload.message ?? payload.error ?? payload.msg
        if (typeof payloadMessage === "string" && payloadMessage.trim()) {
            message = payloadMessage
        }

        const payloadCode = payload.code
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

    return new PolymarketApiError(message, response.status, {
        code,
        details: {
            path,
            ...(details ?? {}),
        },
    })
}

function appendQueryParams(
    url: string,
    query?: Record<string, string | number | boolean | undefined>
): string {
    if (!query) {
        return url
    }

    const searchParams = new URLSearchParams()

    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
            searchParams.set(key, String(value))
        }
    }

    const queryString = searchParams.toString()
    return queryString ? `${url}?${queryString}` : url
}

function normalizeBase64(value: string): string {
    return value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .replace(/[^A-Za-z0-9+/=]/g, "")
}

function toUrlSafeBase64(value: string): string {
    return value.replace(/\+/g, "-").replace(/\//g, "_")
}
