import { createHmac, randomBytes } from "crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createExecutionError, createExecutionErrorDetail, fetchWithTimeout, retryWithBackoff, } from "@valiq-trading/core";
// ---------------------------------------------------------------------------
// Contract addresses (Polygon mainnet)
// ---------------------------------------------------------------------------
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_HOST = "https://clob.polymarket.com";
const DEFAULT_CHAIN_ID = 137;
const POLYMARKET_REQUEST_TIMEOUT_MS = 30_000;
// 6-decimal precision for USDC and conditional token amounts
const AMOUNT_DECIMALS = 6;
const AMOUNT_MULTIPLIER = 10 ** AMOUNT_DECIMALS;
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
};
export class PolymarketApiError extends Error {
    status;
    retryable;
    executionError;
    constructor(message, status, options = {}) {
        super(message);
        this.name = "PolymarketApiError";
        this.status = status;
        this.retryable = options.retryable ?? (status >= 500 || status === 429);
        this.executionError = createExecutionErrorDetail("venue", message, {
            code: options.code,
            retryable: this.retryable,
            details: {
                status,
                ...(options.details ?? {}),
            },
        });
    }
}
// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export class PolymarketClient {
    account;
    address;
    apiKey;
    apiSecret;
    apiPassphrase;
    host;
    chainId;
    signatureType;
    funderAddress;
    // Per-token metadata caches (TTL: 5 minutes)
    tickSizeCache = new Map();
    negRiskCache = new Map();
    feeRateCache = new Map();
    CACHE_TTL_MS = 300_000;
    constructor(credentials) {
        const pk = credentials.privateKey.startsWith("0x")
            ? credentials.privateKey
            : `0x${credentials.privateKey}`;
        this.account = privateKeyToAccount(pk);
        this.address = this.account.address;
        this.apiKey = credentials.apiKey;
        this.apiSecret = credentials.apiSecret;
        this.apiPassphrase = credentials.apiPassphrase;
        this.host = (credentials.host ?? DEFAULT_HOST).replace(/\/+$/, "");
        this.chainId = credentials.chainId ?? DEFAULT_CHAIN_ID;
        this.signatureType = 1;
        const normalizedFunder = credentials.funderAddress.trim();
        if (!normalizedFunder) {
            throw new Error("Polymarket funderAddress is required");
        }
        if (!normalizedFunder.startsWith("0x")) {
            throw new Error("Polymarket funderAddress must be a 0x-prefixed address");
        }
        this.funderAddress = normalizedFunder;
    }
    getAddress() {
        return this.address;
    }
    getFunderAddress() {
        return this.funderAddress;
    }
    getSignatureType() {
        return this.signatureType;
    }
    // -----------------------------------------------------------------------
    // Market discovery (L0 — no auth required)
    // -----------------------------------------------------------------------
    async getMarkets(params) {
        const query = new URLSearchParams();
        if (params?.nextCursor)
            query.set("next_cursor", params.nextCursor);
        if (params?.limit)
            query.set("limit", String(params.limit));
        if (params?.active !== undefined)
            query.set("active", String(params.active));
        const raw = await this.requestPublic(`/markets${query.toString() ? `?${query}` : ""}`);
        return {
            ...raw,
            data: raw.data.map(mapRawMarket),
        };
    }
    async getAllActiveMarkets() {
        const all = [];
        let cursor;
        do {
            const page = await this.getMarkets({ nextCursor: cursor, active: true, limit: 100 });
            all.push(...page.data);
            cursor = page.next_cursor === "LTE=" ? undefined : page.next_cursor;
        } while (cursor);
        return all;
    }
    async getMarket(conditionId) {
        const raw = await this.requestPublic(`/market/${conditionId}`);
        return mapRawMarket(raw);
    }
    async getOrderBook(tokenId) {
        return this.requestPublic(`/book?token_id=${tokenId}`);
    }
    async getMidpoint(tokenId) {
        const resp = await this.requestPublic(`/midpoint?token_id=${tokenId}`);
        return Number(resp.mid);
    }
    async getPrice(tokenId, side) {
        const sideParam = side.toUpperCase();
        const resp = await this.requestPublic(`/price?token_id=${tokenId}&side=${sideParam}`);
        return Number(resp.price);
    }
    async getSpread(tokenId) {
        const resp = await this.requestPublic(`/spread?token_id=${tokenId}`);
        return {
            bid: Number(resp.bid),
            ask: Number(resp.ask),
            spread: Number(resp.spread),
        };
    }
    async getTickSize(tokenId) {
        const cached = this.tickSizeCache.get(tokenId);
        if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
            return cached.value;
        }
        const resp = await this.requestPublic(`/tick-size?token_id=${tokenId}`);
        this.tickSizeCache.set(tokenId, { value: resp.minimum_tick_size, fetchedAt: Date.now() });
        return resp.minimum_tick_size;
    }
    async getNegRisk(tokenId) {
        const cached = this.negRiskCache.get(tokenId);
        if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
            return cached.value;
        }
        const resp = await this.requestPublic(`/neg-risk?token_id=${tokenId}`);
        this.negRiskCache.set(tokenId, { value: resp.neg_risk, fetchedAt: Date.now() });
        return resp.neg_risk;
    }
    async getFeeRateBps(tokenId) {
        const cached = this.feeRateCache.get(tokenId);
        if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
            return cached.value;
        }
        const resp = await this.requestPublic(`/fee-rate?token_id=${tokenId}&sig_type=${this.signatureType}`);
        const value = Number(resp.fee_rate_bps);
        this.feeRateCache.set(tokenId, { value, fetchedAt: Date.now() });
        return value;
    }
    // -----------------------------------------------------------------------
    // Trading (L2 — HMAC auth required)
    // -----------------------------------------------------------------------
    async createOrder(params) {
        const tickSize = await this.getTickSize(params.tokenId);
        const negRisk = params.negRisk ?? await this.getNegRisk(params.tokenId);
        const feeRateBps = await this.getFeeRateBps(params.tokenId);
        const maker = this.funderAddress;
        const price = roundToTickSize(params.price, tickSize);
        const { makerAmount, takerAmount } = calculateOrderAmounts(params.side, params.size, price);
        const salt = generateSalt();
        const sideEnum = params.side === "buy" ? 0 : 1;
        const expiration = params.expiration ?? 0;
        const exchangeAddress = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
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
        };
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
        });
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
        };
        const response = await this.requestAuthenticated("POST", "/order", orderBody);
        if (!response) {
            throw createExecutionError("venue", "Polymarket order returned empty response", {
                code: "EMPTY_RESPONSE",
                retryable: true,
                details: {
                    tokenId: params.tokenId,
                    side: params.side,
                },
            });
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
            });
        }
        return response;
    }
    async getOrder(orderId) {
        const response = await this.requestAuthenticated("GET", `/data/order/${orderId}`);
        if (!response) {
            throw createExecutionError("venue", `Order ${orderId} not found`, {
                code: "ORDER_NOT_FOUND",
                retryable: false,
                details: {
                    orderId,
                },
            });
        }
        return response;
    }
    async getOpenOrders(params) {
        const response = await this.requestAuthenticated("GET", "/data/orders", undefined, {
            market: params?.market,
            asset_id: params?.assetId,
        });
        return Array.isArray(response) ? response : [];
    }
    async cancelOrder(orderId) {
        await this.requestAuthenticated("DELETE", "/order", { orderID: orderId });
    }
    async cancelOrders(orderIds) {
        await this.requestAuthenticated("DELETE", "/orders", orderIds);
    }
    async cancelAll() {
        await this.requestAuthenticated("DELETE", "/cancel-all");
    }
    async getTrades(params) {
        const allTrades = [];
        let cursor;
        do {
            const response = await this.requestAuthenticated("GET", "/data/trades", undefined, {
                market: params?.market,
                asset_id: params?.assetId,
                before: params?.before,
                after: params?.after,
                next_cursor: cursor,
            });
            if (Array.isArray(response)) {
                allTrades.push(...response);
                cursor = undefined;
            }
            else if (response && "data" in response && Array.isArray(response.data)) {
                allTrades.push(...response.data);
                cursor = response.next_cursor === "LTE=" ? undefined : response.next_cursor;
            }
            else {
                cursor = undefined;
            }
        } while (cursor);
        return allTrades;
    }
    /** Get USDC balance (converted from raw 6-decimal integer to USD) */
    async getBalance() {
        const balance = await this.getBalanceAllowance({
            assetType: "COLLATERAL",
        });
        if (!balance?.balance)
            return 0;
        return Number(balance.balance) / AMOUNT_MULTIPLIER;
    }
    /** Get conditional token balance for a specific token (converted from raw 6-decimal integer) */
    async getTokenBalance(tokenId) {
        const balance = await this.getBalanceAllowance({
            assetType: "CONDITIONAL",
            tokenId,
        });
        if (!balance?.balance)
            return 0;
        return Number(balance.balance) / AMOUNT_MULTIPLIER;
    }
    async getBalanceAllowance(params) {
        return this.requestAuthenticated("GET", "/balance-allowance", undefined, {
            asset_type: params.assetType,
            token_id: params.tokenId,
            signature_type: this.signatureType,
        });
    }
    // -----------------------------------------------------------------------
    // HTTP layer
    // -----------------------------------------------------------------------
    async requestPublic(path) {
        return retryWithBackoff(async () => {
            const response = await fetchWithTimeout(`${this.host}${path}`, {
                headers: { "Content-Type": "application/json" },
            }, POLYMARKET_REQUEST_TIMEOUT_MS, `Polymarket request ${path}`);
            if (!response.ok) {
                throw await toPolymarketApiError(response, path);
            }
            return (await response.json());
        }, 3, 1000);
    }
    async requestAuthenticated(method, path, body, query) {
        return retryWithBackoff(async () => {
            const bodyString = body ? JSON.stringify(body) : "";
            const headers = this.buildL2Headers(method, path, bodyString);
            const url = appendQueryParams(`${this.host}${path}`, query);
            const init = {
                method,
                headers: {
                    ...headers,
                    "Content-Type": "application/json",
                },
            };
            if (body && (method === "POST" || method === "PUT" || method === "DELETE")) {
                init.body = bodyString;
            }
            const response = await fetchWithTimeout(url, init, POLYMARKET_REQUEST_TIMEOUT_MS, `Polymarket authenticated request ${path}`);
            if (!response.ok) {
                throw await toPolymarketApiError(response, path);
            }
            if (response.status === 204) {
                return undefined;
            }
            return (await response.json());
        }, 3, 1000);
    }
    buildL2Headers(method, requestPath, body = "") {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const message = timestamp + method + requestPath + body;
        const hmacKey = Buffer.from(normalizeBase64(this.apiSecret), "base64");
        const signature = toUrlSafeBase64(createHmac("sha256", hmacKey).update(message).digest("base64"));
        return {
            POLY_ADDRESS: this.address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: timestamp,
            POLY_API_KEY: this.apiKey,
            POLY_PASSPHRASE: this.apiPassphrase,
        };
    }
}
function mapRawMarket(raw) {
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
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function calculateOrderAmounts(side, size, price) {
    if (side === "buy") {
        return {
            makerAmount: toRawAmount(size * price),
            takerAmount: toRawAmount(size),
        };
    }
    return {
        makerAmount: toRawAmount(size),
        takerAmount: toRawAmount(size * price),
    };
}
function toRawAmount(amount) {
    return BigInt(Math.floor(amount * AMOUNT_MULTIPLIER));
}
function roundToTickSize(price, tickSize) {
    const tick = Number(tickSize);
    if (tick <= 0)
        return price;
    return Math.round(price / tick) * tick;
}
function generateSalt() {
    const bytes = randomBytes(32);
    return BigInt("0x" + bytes.toString("hex"));
}
async function toPolymarketApiError(response, path) {
    let message = `${response.status} ${response.statusText}`;
    let code;
    let details;
    try {
        const payload = await response.json();
        details = payload;
        const payloadMessage = payload.errorMsg ?? payload.message ?? payload.error ?? payload.msg;
        if (typeof payloadMessage === "string" && payloadMessage.trim()) {
            message = payloadMessage;
        }
        const payloadCode = payload.code;
        if (typeof payloadCode === "string" || typeof payloadCode === "number") {
            code = String(payloadCode);
        }
    }
    catch {
        const body = await response.text().catch(() => "");
        if (body) {
            message = body;
            details = { body };
        }
    }
    return new PolymarketApiError(message, response.status, {
        code,
        details: {
            path,
            ...(details ?? {}),
        },
    });
}
function appendQueryParams(url, query) {
    if (!query) {
        return url;
    }
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
            searchParams.set(key, String(value));
        }
    }
    const queryString = searchParams.toString();
    return queryString ? `${url}?${queryString}` : url;
}
function normalizeBase64(value) {
    return value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .replace(/[^A-Za-z0-9+/=]/g, "");
}
function toUrlSafeBase64(value) {
    return value.replace(/\+/g, "-").replace(/\//g, "_");
}
