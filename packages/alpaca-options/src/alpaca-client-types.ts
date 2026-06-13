export interface AlpacaAccountResponse {
    id: string
    account_number?: string
    cash?: string
    equity: string
    buying_power: string
    regt_buying_power?: string
    initial_margin?: string
    maintenance_margin?: string
    unrealized_pl?: string
    last_equity?: string
    portfolio_value?: string
}

export interface AlpacaAccountActivity {
    id: string
    activity_type: string
    date?: string
    transaction_time?: string
    net_amount?: string
    description?: string
    symbol?: string
    qty?: string
    price?: string
    status?: string
    order_id?: string
    side?: string
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
    client_order_id?: string
    symbol?: string
    status: string
    order_class?: string
    side?: "buy" | "sell"
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
        position_intent?: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
        ratio_qty?: string | number
    }>
}

export interface AlpacaClockResponse {
    timestamp?: string
    isOpen: boolean
    nextOpen?: string
    nextClose?: string
}

export interface AlpacaOptionContract {
    symbol: string
    name?: string
    status?: string
    tradable?: boolean
    expirationDate?: string
    underlyingSymbol?: string
    optionType?: "call" | "put"
    strikePrice?: number
    style?: string
    size?: number
    openInterest?: number
    closePrice?: number
}

export interface AlpacaOptionContractsParams {
    underlyingSymbol: string
    expirationDate?: string
    expirationDateFrom?: string
    expirationDateTo?: string
    strikePriceGte?: number
    strikePriceLte?: number
    optionType?: "call" | "put"
    limit?: number
    pageToken?: string
}

export interface AlpacaOptionChainParams {
    expirationDate?: string
    expirationDateFrom?: string
    expirationDateTo?: string
    strikePriceGte?: number
    strikePriceLte?: number
    optionType?: "call" | "put"
    limit?: number
    pageToken?: string
}

export interface AlpacaOptionQuote {
    bidPrice?: number
    askPrice?: number
    bidSize?: number
    askSize?: number
    timestamp?: string
}

export interface AlpacaOptionTrade {
    price?: number
    size?: number
    timestamp?: string
}

export interface AlpacaOptionGreeks {
    delta?: number
    gamma?: number
    theta?: number
    vega?: number
    rho?: number
}

export interface AlpacaOptionSnapshot {
    symbol: string
    latestQuote?: AlpacaOptionQuote
    latestTrade?: AlpacaOptionTrade
    greeks?: AlpacaOptionGreeks
    impliedVolatility?: number
    openInterest?: number
}

export interface AlpacaOptionSnapshotsResponse {
    snapshots: Record<string, AlpacaOptionSnapshot>
    nextPageToken?: string
}

export interface AlpacaEquityQuote {
    symbol: string
    bidPrice?: number
    askPrice?: number
    bidSize?: number
    askSize?: number
    timestamp?: string
}

export interface AlpacaEquityTrade {
    price?: number
    size?: number
    timestamp?: string
}

export interface AlpacaBar {
    open?: number
    high?: number
    low?: number
    close?: number
    volume?: number
    timestamp?: string
}

export interface AlpacaEquitySnapshot {
    symbol: string
    latestTrade?: AlpacaEquityTrade
    latestQuote?: AlpacaEquityQuote
    minuteBar?: AlpacaBar
    dailyBar?: AlpacaBar
    prevDailyBar?: AlpacaBar
}
