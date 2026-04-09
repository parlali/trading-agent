import { createExecutionError, createExecutionErrorDetail, fetchWithTimeout, formatExecutionError, retryWithBackoff, } from "@valiq-trading/core";
export class AlpacaApiError extends Error {
    status;
    code;
    retryable;
    executionError;
    constructor(message, status, options = {}) {
        super(message);
        this.name = "AlpacaApiError";
        this.status = status;
        this.code = options.code;
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
const ALPACA_REQUEST_TIMEOUT_MS = 30_000;
export class AlpacaClient {
    apiKey;
    secretKey;
    accountId;
    tradingBaseUrl;
    marketDataBaseUrl;
    constructor(config) {
        this.apiKey = config.credentials.apiKey;
        this.secretKey = config.credentials.secretKey;
        this.accountId = config.credentials.accountId;
        this.tradingBaseUrl = config.tradingBaseUrl;
        this.marketDataBaseUrl = config.marketDataBaseUrl;
    }
    async getAccount() {
        return await this.request("/v2/account");
    }
    async getPositions() {
        return await this.request("/v2/positions");
    }
    async getOpenOrders() {
        return await this.request("/v2/orders?status=open&nested=true&direction=desc&limit=500");
    }
    async getOptionContracts(params) {
        const query = new URLSearchParams();
        query.set("underlying_symbols", params.underlyingSymbol.toUpperCase());
        applyOptionChainQueryParams(query, params);
        const response = await this.request(`/v2/options/contracts?${query.toString()}`);
        return normalizeOptionContractsResponse(response);
    }
    async getOptionSnapshotsByUnderlying(underlyingSymbol, params = {}) {
        const query = new URLSearchParams();
        applyOptionChainQueryParams(query, params);
        const suffix = query.toString();
        const response = await this.dataRequest(`/v1beta1/options/snapshots/${encodeURIComponent(underlyingSymbol.toUpperCase())}${suffix ? `?${suffix}` : ""}`);
        return normalizeOptionSnapshotsResponse(response);
    }
    async getOptionSnapshots(symbols) {
        const normalizedSymbols = Array.from(new Set(symbols
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean)));
        if (normalizedSymbols.length === 0) {
            return {
                snapshots: {},
            };
        }
        const response = await this.dataRequest(`/v1beta1/options/snapshots?symbols=${encodeURIComponent(normalizedSymbols.join(","))}`);
        return normalizeOptionSnapshotsResponse(response);
    }
    async getLatestEquityQuote(symbol) {
        const response = await this.dataRequest(`/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/quotes/latest`);
        return normalizeEquityQuoteResponse(symbol, response);
    }
    async getEquitySnapshot(symbol) {
        const response = await this.dataRequest(`/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/snapshot`);
        return normalizeEquitySnapshotResponse(symbol, response);
    }
    async createOrder(intent) {
        const payload = buildCreateOrderPayload(intent);
        const response = await this.request("/v2/orders", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        return mapOrderResponse(response);
    }
    async getOrder(orderId) {
        const response = await this.request(`/v2/orders/${orderId}`);
        return mapOrderResponse(response);
    }
    async cancelOrder(orderId) {
        await this.request(`/v2/orders/${orderId}`, {
            method: "DELETE",
        });
        return await this.getOrder(orderId);
    }
    async replaceOrder(orderId, changes) {
        const payload = {};
        if (changes.quantity !== undefined) {
            payload.qty = changes.quantity;
        }
        if (changes.limitPrice !== undefined) {
            payload.limit_price = changes.limitPrice;
        }
        if (changes.stopPrice !== undefined) {
            throw createExecutionError("pre_validation", "Alpaca iron condor orders do not support stop price modifications", {
                code: "STOP_PRICE_UNSUPPORTED",
                retryable: false,
            });
        }
        if (changes.timeInForce !== undefined && changes.timeInForce !== "day") {
            throw createExecutionError("pre_validation", "Alpaca iron condor orders only support day time in force", {
                code: "TIME_IN_FORCE_UNSUPPORTED",
                retryable: false,
            });
        }
        if (Object.keys(payload).length === 0) {
            throw createExecutionError("pre_validation", "No supported Alpaca order modifications were provided", {
                code: "NO_SUPPORTED_MODIFICATIONS",
                retryable: false,
            });
        }
        const response = await this.request(`/v2/orders/${orderId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
        return mapOrderResponse(response);
    }
    async request(path, init = {}) {
        return await this.requestAgainstBaseUrl(this.tradingBaseUrl, path, init);
    }
    async dataRequest(path, init = {}) {
        return await this.requestAgainstBaseUrl(this.marketDataBaseUrl, path, init);
    }
    async requestAgainstBaseUrl(baseUrl, path, init = {}) {
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
            }, ALPACA_REQUEST_TIMEOUT_MS, `Alpaca request ${path}`);
            if (!response.ok) {
                throw await toAlpacaApiError(response);
            }
            if (response.status === 204) {
                return {};
            }
            return await response.json();
        }, 3, 1000);
    }
}
function mapOrderType(orderType) {
    return orderType === "stop_limit" ? "stop_limit" : orderType;
}
function mapOrderStatus(status) {
    switch (status) {
        case "filled":
            return "filled";
        case "partially_filled":
            return "partially_filled";
        case "canceled":
        case "cancelled":
        case "pending_cancel":
            return "cancelled";
        case "expired":
            return "expired";
        case "rejected":
        case "suspended":
            return "rejected";
        default:
            return "pending";
    }
}
function mapOrderResponse(order) {
    const status = mapOrderStatus(order.status);
    const quantity = order.qty ? Number(order.qty) : undefined;
    const limitPrice = order.limit_price ? Number(order.limit_price) : undefined;
    const intentUpdates = {};
    const errorDetail = status === "rejected"
        ? createExecutionErrorDetail("venue", order.status, {
            code: order.status.toUpperCase(),
            retryable: false,
            details: {
                orderId: order.id,
                status: order.status,
            },
        })
        : undefined;
    if (quantity !== undefined) {
        intentUpdates.quantity = quantity;
    }
    if (limitPrice !== undefined) {
        intentUpdates.limitPrice = limitPrice;
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
    };
}
function applyOptionChainQueryParams(query, params) {
    const expirationDateFrom = params.expirationDateFrom ?? params.expirationDate;
    const expirationDateTo = params.expirationDateTo ?? params.expirationDate;
    if (expirationDateFrom) {
        query.set("expiration_date_gte", expirationDateFrom);
    }
    if (expirationDateTo) {
        query.set("expiration_date_lte", expirationDateTo);
    }
    if (params.strikePriceGte !== undefined) {
        query.set("strike_price_gte", String(params.strikePriceGte));
    }
    if (params.strikePriceLte !== undefined) {
        query.set("strike_price_lte", String(params.strikePriceLte));
    }
    if (params.optionType) {
        query.set("type", params.optionType);
    }
    if (params.limit !== undefined) {
        query.set("limit", String(params.limit));
    }
    if (params.pageToken) {
        query.set("page_token", params.pageToken);
    }
}
function normalizeOptionContractsResponse(payload) {
    const record = asRecord(payload);
    const rawContracts = asArray(record?.option_contracts ?? record?.contracts);
    return {
        contracts: rawContracts.filter(isRecord).map((contract) => normalizeOptionContract(contract)).filter(isDefined),
        nextPageToken: asOptionalString(record?.next_page_token ?? record?.nextPageToken),
    };
}
function normalizeOptionContract(payload) {
    const record = asRecord(payload);
    const symbol = asOptionalString(record?.symbol);
    if (!symbol) {
        return null;
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
    };
}
function normalizeOptionSnapshotsResponse(payload) {
    const record = asRecord(payload);
    const rawSnapshots = asRecord(record?.snapshots);
    const snapshots = {};
    const snapshotEntries = rawSnapshots
        ? Object.entries(rawSnapshots)
        : Object.entries(record ?? {}).filter(([, rawSnapshot]) => isRecord(rawSnapshot));
    for (const [symbol, rawSnapshot] of snapshotEntries) {
        const snapshot = normalizeOptionSnapshot(symbol, rawSnapshot);
        if (snapshot) {
            snapshots[snapshot.symbol] = snapshot;
        }
    }
    return {
        snapshots,
        nextPageToken: asOptionalString(record?.next_page_token ?? record?.nextPageToken),
    };
}
function normalizeOptionSnapshot(fallbackSymbol, payload) {
    const record = asRecord(payload);
    const symbol = asOptionalString(record?.symbol) ?? fallbackSymbol;
    if (!symbol) {
        return null;
    }
    return {
        symbol,
        latestQuote: normalizeQuote(record?.latestQuote ?? record?.latest_quote),
        latestTrade: normalizeTrade(record?.latestTrade ?? record?.latest_trade),
        greeks: normalizeGreeks(record?.greeks),
        impliedVolatility: asOptionalNumber(record?.impliedVolatility ?? record?.implied_volatility),
        openInterest: asOptionalNumber(record?.openInterest ?? record?.open_interest),
    };
}
function normalizeEquityQuoteResponse(symbol, payload) {
    const record = asRecord(payload);
    const quote = asRecord(record?.quote) ?? record;
    const normalizedQuote = normalizeQuote(quote);
    return {
        symbol: symbol.toUpperCase(),
        ...(normalizedQuote ?? {}),
    };
}
function normalizeEquitySnapshotResponse(symbol, payload) {
    const record = asRecord(payload);
    const latestQuote = normalizeQuote(record?.latestQuote ?? record?.latest_quote);
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
    };
}
function normalizeQuote(payload) {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    return {
        bidPrice: asOptionalNumber(record.bp ?? record.bid_price ?? record.bidPrice),
        askPrice: asOptionalNumber(record.ap ?? record.ask_price ?? record.askPrice),
        bidSize: asOptionalNumber(record.bs ?? record.bid_size ?? record.bidSize),
        askSize: asOptionalNumber(record.as ?? record.ask_size ?? record.askSize),
        timestamp: asOptionalString(record.t ?? record.timestamp),
    };
}
function normalizeTrade(payload) {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    return {
        price: asOptionalNumber(record.p ?? record.price),
        size: asOptionalNumber(record.s ?? record.size),
        timestamp: asOptionalString(record.t ?? record.timestamp),
    };
}
function normalizeGreeks(payload) {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    return {
        delta: asOptionalNumber(record.delta),
        gamma: asOptionalNumber(record.gamma),
        theta: asOptionalNumber(record.theta),
        vega: asOptionalNumber(record.vega),
        rho: asOptionalNumber(record.rho),
    };
}
function normalizeBar(payload) {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    return {
        open: asOptionalNumber(record.o ?? record.open),
        high: asOptionalNumber(record.h ?? record.high),
        low: asOptionalNumber(record.l ?? record.low),
        close: asOptionalNumber(record.c ?? record.close),
        volume: asOptionalNumber(record.v ?? record.volume),
        timestamp: asOptionalString(record.t ?? record.timestamp),
    };
}
function normalizeOptionType(value) {
    const normalized = asOptionalString(value)?.toLowerCase();
    if (normalized === "call" || normalized === "put") {
        return normalized;
    }
    return undefined;
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
function isRecord(value) {
    return Boolean(asRecord(value));
}
function isDefined(value) {
    return value !== null && value !== undefined;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asOptionalString(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function asOptionalBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function asOptionalNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
function buildCreateOrderPayload(intent) {
    if (!intent.legs || intent.legs.length !== 4) {
        throw createExecutionError("pre_validation", "Alpaca options orders must be submitted as exactly 4 legs", {
            code: "INVALID_LEG_COUNT",
            retryable: false,
        });
    }
    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        throw createExecutionError("pre_validation", "Alpaca options orders require a positive integer structure quantity", {
            code: "INVALID_QUANTITY",
            retryable: false,
        });
    }
    if (intent.orderType !== "limit") {
        throw createExecutionError("pre_validation", "Alpaca options orders only support limit pricing", {
            code: "ORDER_TYPE_UNSUPPORTED",
            retryable: false,
        });
    }
    if (intent.timeInForce !== "day") {
        throw createExecutionError("pre_validation", "Alpaca options orders only support day time in force", {
            code: "TIME_IN_FORCE_UNSUPPORTED",
            retryable: false,
        });
    }
    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        throw createExecutionError("pre_validation", "Alpaca options orders require a positive limit price", {
            code: "INVALID_LIMIT_PRICE",
            retryable: false,
        });
    }
    if (intent.stopPrice !== undefined) {
        throw createExecutionError("pre_validation", "Alpaca options orders do not support stop prices", {
            code: "STOP_PRICE_UNSUPPORTED",
            retryable: false,
        });
    }
    if (intent.legs.some((leg) => !Number.isInteger(leg.quantity) || leg.quantity <= 0)) {
        throw createExecutionError("pre_validation", "Alpaca options orders require positive integer leg ratios", {
            code: "INVALID_LEG_RATIO",
            retryable: false,
        });
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
    };
}
function resolveOrderTimestamp(order) {
    const rawTimestamp = order.updated_at ?? order.submitted_at;
    const parsed = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
}
async function toAlpacaApiError(response) {
    let message = `${response.status} ${response.statusText}`;
    let code;
    let details;
    try {
        const payload = await response.json();
        details = payload;
        const payloadMessage = payload.message;
        if (typeof payloadMessage === "string" && payloadMessage.trim()) {
            message = payloadMessage;
        }
        const payloadCode = payload.code ?? payload.error_code;
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
    return new AlpacaApiError(message, response.status, {
        code,
        details,
    });
}
