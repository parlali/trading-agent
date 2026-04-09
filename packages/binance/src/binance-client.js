import { createHmac } from "crypto";
import { createExecutionErrorDetail, fetchWithTimeout, retryWithBackoff } from "@valiq-trading/core";
export class BinanceApiError extends Error {
    status;
    code;
    retryable;
    executionError;
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryable = isRetryableBinanceError(status, code);
        this.executionError = createExecutionErrorDetail("venue", message, {
            code: code !== undefined ? String(code) : undefined,
            retryable: this.retryable,
            details: {
                status,
            },
        });
    }
}
const DEFAULT_BASE_URL = "https://fapi.binance.com";
const DEFAULT_RECV_WINDOW = 5000;
const BINANCE_REQUEST_TIMEOUT_MS = 30_000;
export class BinanceClient {
    apiKey;
    apiSecret;
    baseUrl;
    recvWindow;
    usedWeight1m = null;
    constructor(credentials) {
        this.apiKey = credentials.apiKey;
        this.apiSecret = credentials.apiSecret;
        this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
        this.recvWindow = credentials.recvWindow ?? DEFAULT_RECV_WINDOW;
    }
    getBaseUrl() {
        return this.baseUrl;
    }
    getUsedWeight1m() {
        return this.usedWeight1m;
    }
    async ping() {
        await this.publicRequest("GET", "/fapi/v1/ping");
    }
    async getExchangeInfo() {
        return await this.publicRequest("GET", "/fapi/v1/exchangeInfo");
    }
    async getAccount() {
        return await this.signedRequest("GET", "/fapi/v2/account");
    }
    async getPositionRisk(symbol) {
        return await this.signedRequest("GET", "/fapi/v2/positionRisk", {
            symbol,
        });
    }
    async getOrder(symbol, orderId) {
        return await this.signedRequest("GET", "/fapi/v1/order", {
            symbol,
            orderId,
        });
    }
    async getOpenOrders(symbol) {
        return await this.signedRequest("GET", "/fapi/v1/openOrders", {
            symbol,
        });
    }
    async createOrder(params) {
        const payload = {
            symbol: params.symbol,
            side: params.side,
            type: params.type,
            quantity: params.quantity,
            price: params.price,
            stopPrice: params.stopPrice,
            timeInForce: params.timeInForce,
            reduceOnly: params.reduceOnly,
            closePosition: params.closePosition,
            workingType: params.workingType,
        };
        return await this.signedRequest("POST", "/fapi/v1/order", payload);
    }
    async cancelOrder(symbol, orderId) {
        return await this.signedRequest("DELETE", "/fapi/v1/order", {
            symbol,
            orderId,
        });
    }
    async setLeverage(symbol, leverage) {
        return await this.signedRequest("POST", "/fapi/v1/leverage", {
            symbol,
            leverage,
        });
    }
    async setMarginType(symbol, marginType) {
        await this.signedRequest("POST", "/fapi/v1/marginType", {
            symbol,
            marginType,
        });
    }
    async setPositionMode(dualSidePosition) {
        await this.signedRequest("POST", "/fapi/v1/positionSide/dual", {
            dualSidePosition: dualSidePosition ? "true" : "false",
        });
    }
    async getBookTicker(symbol) {
        return await this.publicRequest("GET", "/fapi/v1/ticker/bookTicker", {
            symbol,
        });
    }
    async getPremiumIndex(symbol) {
        return await this.publicRequest("GET", "/fapi/v1/premiumIndex", {
            symbol,
        });
    }
    async getFundingRates(symbol, limit = 1) {
        return await this.publicRequest("GET", "/fapi/v1/fundingRate", {
            symbol,
            limit,
        });
    }
    async getDepth(symbol, limit = 20) {
        return await this.publicRequest("GET", "/fapi/v1/depth", {
            symbol,
            limit,
        });
    }
    async publicRequest(method, path, params) {
        return await retryWithBackoff(async () => {
            const query = buildQuery(params);
            const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
            const response = await fetchWithTimeout(url, {
                method,
                headers: {
                    "Content-Type": "application/json",
                },
            }, BINANCE_REQUEST_TIMEOUT_MS, `Binance request ${path}`);
            this.captureRateLimitHeaders(response);
            return await parseBinanceResponse(response);
        }, 2, 300);
    }
    async signedRequest(method, path, params) {
        return await retryWithBackoff(async () => {
            const signedParams = {
                ...params,
                timestamp: Date.now(),
                recvWindow: this.recvWindow,
            };
            const query = buildQuery(signedParams);
            const signature = this.sign(query);
            const url = `${this.baseUrl}${path}?${query}&signature=${signature}`;
            const response = await fetchWithTimeout(url, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    "X-MBX-APIKEY": this.apiKey,
                },
            }, BINANCE_REQUEST_TIMEOUT_MS, `Binance signed request ${path}`);
            this.captureRateLimitHeaders(response);
            return await parseBinanceResponse(response);
        }, 2, 300);
    }
    captureRateLimitHeaders(response) {
        const usedWeight = response.headers.get("x-mbx-used-weight-1m");
        if (!usedWeight) {
            return;
        }
        const parsed = Number(usedWeight);
        if (Number.isFinite(parsed)) {
            this.usedWeight1m = parsed;
        }
    }
    sign(query) {
        return createHmac("sha256", this.apiSecret).update(query).digest("hex");
    }
}
function buildQuery(params) {
    if (!params) {
        return "";
    }
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
            continue;
        }
        searchParams.set(key, String(value));
    }
    return searchParams.toString();
}
async function parseBinanceResponse(response) {
    if (response.ok) {
        if (response.status === 204) {
            return {};
        }
        return await response.json();
    }
    let code;
    let message = `${response.status} ${response.statusText}`;
    try {
        const payload = await response.json();
        code = payload.code;
        if (payload.msg) {
            message = payload.msg;
        }
    }
    catch {
        const text = await response.text().catch(() => "");
        if (text) {
            message = text;
        }
    }
    throw new BinanceApiError(message, response.status, code);
}
function normalizeBaseUrl(value) {
    return (value ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}
function isRetryableBinanceError(status, code) {
    if (status >= 500 || status === 429) {
        return true;
    }
    if (code === undefined) {
        return false;
    }
    const retryableCodes = new Set([-1001, -1003, -1006, -1007, -1008, -1021, -1022]);
    return retryableCodes.has(code);
}
