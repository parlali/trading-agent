import type {
    AlpacaBar,
    AlpacaClockResponse,
    AlpacaEquityQuote,
    AlpacaEquitySnapshot,
    AlpacaOptionChainParams,
    AlpacaOptionContract,
    AlpacaOptionGreeks,
    AlpacaOptionQuote,
    AlpacaOptionSnapshot,
    AlpacaOptionSnapshotsResponse,
    AlpacaOptionTrade,
} from "./alpaca-client-types"

export function applyOptionChainQueryParams(
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

export function normalizeOptionContractsResponse(
    payload: unknown
): { contracts: AlpacaOptionContract[]; nextPageToken?: string } {
    const record = asRecord(payload)
    const rawContracts = asArray(record?.option_contracts ?? record?.contracts)

    return {
        contracts: rawContracts.filter(isRecord).map((contract) => normalizeOptionContract(contract)).filter(isDefined),
        nextPageToken: asOptionalString(record?.next_page_token ?? record?.nextPageToken),
    }
}

export function normalizeClockResponse(payload: unknown): AlpacaClockResponse {
    const record = asRecord(payload)

    return {
        timestamp: asOptionalString(record?.timestamp),
        isOpen: record?.is_open === true || record?.isOpen === true,
        nextOpen: asOptionalString(record?.next_open ?? record?.nextOpen),
        nextClose: asOptionalString(record?.next_close ?? record?.nextClose),
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

export function normalizeOptionSnapshotsResponse(
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

export function normalizeEquityQuoteResponse(
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

export function normalizeEquitySnapshotResponse(
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
