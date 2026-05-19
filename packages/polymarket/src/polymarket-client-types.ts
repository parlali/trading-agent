export interface PolymarketCredentials {
    privateKey: string
    apiKey: string
    apiSecret: string
    apiPassphrase: string
    host?: string
    gammaHost?: string
    dataHost?: string
    chainId?: number
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
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
}

export interface PreparedPolymarketOrder {
    orderBody: Record<string, unknown>
    signedOrderFingerprint: string
    signedOrderMetadata: Record<string, unknown>
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
    signedOrderFingerprint?: string
    signed_order_fingerprint?: string
    salt?: string
    metadata?: Record<string, unknown>
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
    maker_order_id?: string
    signedOrderFingerprint?: string
    signed_order_fingerprint?: string
    metadata?: Record<string, unknown>
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
    canonicalOrderId: string
    side: "buy" | "sell"
    size: number
    price: number
    orderType: "GTC" | "GTD" | "FOK" | "FAK"
    expiration?: number
    negRisk?: boolean
}

export interface PaginatedResponse<T> {
    data: T[]
    next_cursor: string
    limit: number
    count: number
}
