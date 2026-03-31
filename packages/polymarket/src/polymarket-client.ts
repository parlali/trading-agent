import { createHmac, randomBytes } from "crypto"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { retryWithBackoff } from "@valiq-trading/core"

// ---------------------------------------------------------------------------
// Contract addresses (Polygon mainnet)
// ---------------------------------------------------------------------------

const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

const DEFAULT_HOST = "https://clob.polymarket.com"
const DEFAULT_CHAIN_ID = 137

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
    /** Chain ID. 137 for Polygon mainnet, 80002 for Amoy testnet */
    chainId?: number
}

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
    private readonly chainId: number
    private readonly signatureType = 0

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
        this.chainId = credentials.chainId ?? DEFAULT_CHAIN_ID
    }

    getAddress(): string {
        return this.address
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

    async getMarket(conditionId: string): Promise<PolymarketMarket> {
        const raw = await this.requestPublic<RawMarket>(`/market/${conditionId}`)
        return mapRawMarket(raw)
    }

    async getOrderBook(tokenId: string): Promise<PolymarketOrderBook> {
        return this.requestPublic<PolymarketOrderBook>(`/order-book?token_id=${tokenId}`)
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
            `/fee-rate?token_id=${tokenId}&sig_type=0`
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
            maker: this.address,
            signer: this.address,
            taker: ZERO_ADDRESS,
            tokenId: BigInt(params.tokenId),
            makerAmount,
            takerAmount,
            expiration: BigInt(expiration),
            nonce: 0n,
            feeRateBps: BigInt(feeRateBps),
            side: sideEnum,
            signatureType: 0,
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
                maker: this.address,
                signer: this.address,
                taker: ZERO_ADDRESS,
                tokenId: params.tokenId,
                makerAmount: makerAmount.toString(),
                takerAmount: takerAmount.toString(),
                expiration: String(expiration),
                nonce: "0",
                feeRateBps: String(feeRateBps),
                side: sideEnum,
                signatureType: 0,
                signature,
            },
            owner: this.address,
            orderType: params.orderType,
        }

        const response = await this.requestAuthenticated<PostOrderResponse>(
            "POST",
            "/order",
            orderBody
        )

        if (!response.success) {
            throw new Error(`Polymarket order failed: ${response.errorMsg}`)
        }

        return response
    }

    async getOrder(orderId: string): Promise<PolymarketOpenOrder> {
        return this.requestAuthenticated<PolymarketOpenOrder>("GET", `/order/${orderId}`)
    }

    async getOpenOrders(params?: {
        market?: string
        assetId?: string
    }): Promise<PolymarketOpenOrder[]> {
        return this.requestAuthenticated<PolymarketOpenOrder[]>("GET", "/orders", undefined, {
            market: params?.market,
            asset_id: params?.assetId,
        })
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
            >("GET", "/trades", undefined, {
                market: params?.market,
                asset_id: params?.assetId,
                before: params?.before,
                after: params?.after,
                next_cursor: cursor,
            })

            if (Array.isArray(response)) {
                allTrades.push(...response)
                cursor = undefined
            } else {
                allTrades.push(...response.data)
                cursor = response.next_cursor === "LTE=" ? undefined : response.next_cursor
            }
        } while (cursor)

        return allTrades
    }

    /** Get USDC balance (converted from raw 6-decimal integer to USD) */
    async getBalance(): Promise<number> {
        const resp = await this.requestAuthenticated<{ balance: string }>(
            "GET",
            "/balance-allowance",
            undefined,
            {
                asset_type: "COLLATERAL",
                signature_type: this.signatureType,
            }
        )
        return Number(resp.balance) / AMOUNT_MULTIPLIER
    }

    /** Get conditional token balance for a specific token (converted from raw 6-decimal integer) */
    async getTokenBalance(tokenId: string): Promise<number> {
        const resp = await this.requestAuthenticated<{ balance: string }>(
            "GET",
            "/balance-allowance",
            undefined,
            {
                asset_type: "CONDITIONAL",
                token_id: tokenId,
                signature_type: this.signatureType,
            }
        )
        return Number(resp.balance) / AMOUNT_MULTIPLIER
    }

    // -----------------------------------------------------------------------
    // HTTP layer
    // -----------------------------------------------------------------------

    private async requestPublic<T>(path: string): Promise<T> {
        return retryWithBackoff(async () => {
            const response = await fetch(`${this.host}${path}`, {
                headers: { "Content-Type": "application/json" },
            })

            if (!response.ok) {
                const body = await response.text().catch(() => "")
                throw new Error(`Polymarket API error: ${response.status} ${response.statusText} ${body}`)
            }

            return (await response.json()) as T
        }, 3, 1000)
    }

    private async requestAuthenticated<T>(
        method: string,
        path: string,
        body?: unknown,
        query?: Record<string, string | number | boolean | undefined>
    ): Promise<T> {
        return retryWithBackoff(async () => {
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

            const response = await fetch(url, init)

            if (!response.ok) {
                const text = await response.text().catch(() => "")
                throw new Error(`Polymarket API error: ${response.status} ${response.statusText} ${text}`)
            }

            if (response.status === 204) {
                return {} as T
            }

            return (await response.json()) as T
        }, 3, 1000)
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
    end_date_iso: string
    market_slug: string
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
        endDateIso: raw.end_date_iso,
        marketSlug: raw.market_slug,
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
