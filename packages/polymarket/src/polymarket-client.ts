import { createHmac, randomBytes } from "crypto"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import {
    createExecutionError,
    createExecutionErrorDetail,
    fetchWithTimeout,
    type ExecutionErrorDetail,
} from "@valiq-trading/core"

// ---------------------------------------------------------------------------
// Contract addresses (Polygon mainnet)
// ---------------------------------------------------------------------------

const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

const DEFAULT_HOST = "https://clob.polymarket.com"
const DEFAULT_GAMMA_HOST = "https://gamma-api.polymarket.com"
const DEFAULT_DATA_HOST = "https://data-api.polymarket.com"
const DEFAULT_CHAIN_ID = 137
const POLYMARKET_REQUEST_TIMEOUT_MS = 30_000

// 6-decimal precision for USDC and conditional token amounts
const AMOUNT_DECIMALS = 6
const AMOUNT_MULTIPLIER = 10 ** AMOUNT_DECIMALS

// ---------------------------------------------------------------------------
// EIP-712 typed data for CTF Exchange orders
// ---------------------------------------------------------------------------

const ORDER_EIP712_TYPES = {
    Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
    ],
} as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolymarketCredentials {
    /** Hex-encoded private key for the trading wallet (with or without 0x prefix) */
    privateKey: string
    /** L2 HMAC API key */
    apiKey: string
    /** L2 HMAC API secret (base64-encoded) */
    apiSecret: string
    /** L2 HMAC API passphrase */
    apiPassphrase: string
    /** CLOB API host. Defaults to https://clob.polymarket.com */
    host?: string
    /** Gamma API host. Defaults to https://gamma-api.polymarket.com */
    gammaHost?: string
    /** Data API host. Defaults to https://data-api.polymarket.com */
    dataHost?: string
    /** Chain ID. 137 for Polygon mainnet, 80002 for Amoy testnet */
    chainId?: number
    /** Polymarket profile or funder address for proxy wallet (type 1) */
    funderAddress: string
}

export type PolymarketSignatureType = 1

export interface PolymarketMarket {
    conditionId: string
    questionId: string
    question: string
    description: string
    category: string
    tokens: PolymarketToken[]
    active: boolean
    closed: boolean
    negRisk: boolean
    minimumOrderSize: number
    minimumTickSize: number
    volume?: number
    liquidity?: number
    endDateIso: string
    marketSlug: string
}

export interface PolymarketToken {
    tokenId: string
    outcome: string
}

export interface PolymarketOrderBook {
    market: string
    assetId: string
    bids: Array<{ price: string; size: string }>
    asks: Array<{ price: string; size: string }>
    hash: string
    timestamp: string
    min_order_size?: string
    tick_size?: string
    neg_risk?: boolean
    last_trade_price?: string
}

export interface PostOrderResponse {
    success: boolean
    errorMsg: string
    orderID: string
    transactionsHashes: string[]
    status: string
}

export interface PolymarketOpenOrder {
    id: string
    status: string
    owner: string
    market: string
    asset_id: string
    side: string
    original_size: string
    size_matched: string
    price: string
    outcome: string
    order_type: string
    created_at: string
    expiration: string
}

export interface PolymarketTrade {
    id: string
    taker_order_id: string
    market: string
    asset_id: string
    side: string
    size: string
    price: string
    fee_rate_bps: string
    status: string
    match_time: string
    outcome: string
    trader_side: string
}

export interface PolymarketBalanceAllowance {
    balance: string
    allowances?: Record<string, string>
}

export interface PolymarketCurrentPosition {
    proxyWallet: string
    asset: string
    conditionId: string
    size: number
    avgPrice: number
    initialValue: number
    currentValue: number
    cashPnl: number
    percentPnl: number
    totalBought: number
    realizedPnl: number
    percentRealizedPnl: number
    curPrice: number
    redeemable: boolean
    mergeable: boolean
    title: string
    slug: string
    icon?: string
    eventId?: string
    eventSlug?: string
    outcome: string
    outcomeIndex?: number
    oppositeOutcome?: string
    oppositeAsset?: string
    endDate: string
    negativeRisk?: boolean
}

export interface CreateOrderParams {
    tokenId: string
    side: "buy" | "sell"
    size: number
    price: number
    orderType: "GTC" | "GTD" | "FOK" | "FAK"
    expiration?: number
    negRisk?: boolean
}

interface PaginatedResponse<T> {
    data: T[]
    next_cursor: string
    limit: number
    count: number
}

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

    async createOrder(params: CreateOrderParams): Promise<PostOrderResponse> {
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

        const salt = generateSalt()
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

        const response = await this.requestAuthenticated<PostOrderResponse>(
            "POST",
            "/order",
            orderBody
        )

        if (!response) {
            throw createExecutionError("venue", "Polymarket order returned empty response", {
                code: "EMPTY_RESPONSE",
                retryable: true,
                details: {
                    tokenId: params.tokenId,
                    side: params.side,
                },
            })
        }

        if (!response.success) {
            throw createExecutionError("venue", response.errorMsg || "Polymarket order rejected", {
                code: response.status || "ORDER_REJECTED",
                retryable: false,
                details: {
                    tokenId: params.tokenId,
                    side: params.side,
                    orderType: params.orderType,
                    response,
                },
            })
        }

        return response
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
        await this.requestAuthenticated("DELETE", "/order", { orderID: orderId })
    }

    async cancelOrders(orderIds: string[]): Promise<void> {
        await this.requestAuthenticated("DELETE", "/orders", orderIds)
    }

    async cancelAll(): Promise<void> {
        await this.requestAuthenticated("DELETE", "/cancel-all")
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
        query?: Record<string, string | number | boolean | undefined>
    ): Promise<T | undefined> {
        return await this.withPolymarketRetry(async () => {
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
        })
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

interface RawMarket {
    condition_id: string
    question_id: string
    question: string
    description: string
    category: string
    tokens: Array<{ token_id: string; outcome: string }>
    active: boolean
    closed: boolean
    neg_risk: boolean
    minimum_order_size: number
    minimum_tick_size: number
    volume?: number | string
    liquidity?: number | string
    end_date_iso: string
    market_slug: string
}

interface RawGammaEvent {
    title?: string
    description?: string
    category?: string
    tags?: Array<{
        label?: string
        slug?: string
    }>
    markets?: RawGammaMarket[]
}

interface RawGammaMarket {
    conditionId?: string
    questionID?: string
    question?: string
    description?: string
    outcomes?: string
    clobTokenIds?: string
    active?: boolean
    closed?: boolean
    negRisk?: boolean
    orderMinSize?: number
    orderPriceMinTickSize?: number
    volume?: number | string
    liquidity?: number | string
    liquidityNum?: number
    volumeNum?: number
    endDateIso?: string
    endDate?: string
    slug?: string
}

interface GammaSearchResponse {
    events: RawGammaEvent[]
}

function mapRawMarket(raw: RawMarket): PolymarketMarket {
    return {
        conditionId: raw.condition_id,
        questionId: raw.question_id,
        question: raw.question,
        description: raw.description,
        category: raw.category,
        tokens: raw.tokens.map((t) => ({ tokenId: t.token_id, outcome: t.outcome })),
        active: raw.active,
        closed: raw.closed,
        negRisk: raw.neg_risk,
        minimumOrderSize: raw.minimum_order_size,
        minimumTickSize: raw.minimum_tick_size,
        volume: typeof raw.volume === "number" ? raw.volume : raw.volume ? Number(raw.volume) : undefined,
        liquidity: typeof raw.liquidity === "number" ? raw.liquidity : raw.liquidity ? Number(raw.liquidity) : undefined,
        endDateIso: raw.end_date_iso,
        marketSlug: raw.market_slug,
    }
}

function collectGammaMarkets(
    events: RawGammaEvent[],
    fallbackCategory?: string
): PolymarketMarket[] {
    const markets = events.flatMap((event) =>
        (event.markets ?? [])
            .map((market) => mapGammaMarket(event, market, fallbackCategory))
            .filter((market): market is PolymarketMarket => market !== null)
    )

    return markets
        .filter((market) => market.active && !market.closed)
        .sort((left, right) => (right.liquidity ?? 0) - (left.liquidity ?? 0))
        .filter((market, index, all) =>
            all.findIndex((candidate) => candidate.conditionId === market.conditionId) === index
        )
}

function mapGammaMarket(
    event: RawGammaEvent,
    market: RawGammaMarket,
    fallbackCategory?: string
): PolymarketMarket | null {
    const conditionId = asNonEmptyString(market.conditionId)
    const question = asNonEmptyString(market.question)

    if (!conditionId || !question) {
        return null
    }

    const category = resolveGammaCategory(event, fallbackCategory)
    const outcomes = parseJsonStringArray(market.outcomes)
    const tokenIds = parseJsonStringArray(market.clobTokenIds)

    return {
        conditionId,
        questionId: asNonEmptyString(market.questionID) ?? conditionId,
        question,
        description: asNonEmptyString(market.description) ?? asNonEmptyString(event.description) ?? question,
        category,
        tokens: outcomes.map((outcome, index) => ({
            tokenId: tokenIds[index] ?? "",
            outcome,
        })).filter((token) => token.tokenId.length > 0),
        active: market.active === true,
        closed: market.closed === true,
        negRisk: market.negRisk === true,
        minimumOrderSize: typeof market.orderMinSize === "number" ? market.orderMinSize : 0,
        minimumTickSize: typeof market.orderPriceMinTickSize === "number" ? market.orderPriceMinTickSize : 0.01,
        volume: coerceNumber(market.volumeNum ?? market.volume),
        liquidity: coerceNumber(market.liquidityNum ?? market.liquidity),
        endDateIso: asNonEmptyString(market.endDateIso) ?? toIsoDate(market.endDate),
        marketSlug: asNonEmptyString(market.slug) ?? conditionId,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calculateOrderAmounts(
    side: "buy" | "sell",
    size: number,
    price: number
): { makerAmount: bigint; takerAmount: bigint } {
    if (side === "buy") {
        return {
            makerAmount: toRawAmount(size * price),
            takerAmount: toRawAmount(size),
        }
    }
    return {
        makerAmount: toRawAmount(size),
        takerAmount: toRawAmount(size * price),
    }
}

function toRawAmount(amount: number): bigint {
    return BigInt(Math.floor(amount * AMOUNT_MULTIPLIER))
}

function roundToTickSize(price: number, tickSize: string): number {
    const tick = Number(tickSize)
    if (tick <= 0) return price
    return Math.round(price / tick) * tick
}

function generateSalt(): bigint {
    const bytes = randomBytes(32)
    return BigInt("0x" + bytes.toString("hex"))
}

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

function clampGammaEventLimit(limit: number): number {
    return Math.max(1, Math.min(Math.ceil(limit), 50))
}

function parseJsonStringArray(value: string | undefined): string[] {
    if (!value) {
        return []
    }

    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            : []
    } catch {
        return []
    }
}

function resolveGammaCategory(
    event: RawGammaEvent,
    fallbackCategory?: string
): string {
    return (
        asNonEmptyString(event.category) ??
        event.tags?.find((tag) => asNonEmptyString(tag.slug) === fallbackCategory)?.label ??
        event.tags?.find((tag) => asNonEmptyString(tag.label))?.label ??
        fallbackCategory ??
        "unknown"
    )
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function coerceNumber(value: number | string | undefined): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

function toIsoDate(value: string | undefined): string {
    if (!value) {
        return ""
    }

    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) {
        return ""
    }

    return new Date(parsed).toISOString().slice(0, 10)
}

function toSlugCandidate(value: string): string | null {
    const fromUrl = value.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/i)?.[1]
    const raw = fromUrl ?? value
    const normalized = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

    return normalized.length > 0 ? normalized : null
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
