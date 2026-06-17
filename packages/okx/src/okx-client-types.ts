export type OKXMarginMode = "cross" | "isolated"
export type OKXPositionMode = "net_mode" | "long_short_mode"
export type OKXApiPosSide = "net" | "long" | "short"
export type OKXOrderType = "market" | "limit" | "ioc" | "fok" | "conditional"
export type OKXAlgoOrderHistoryState = "effective" | "canceled" | "order_failed"

export interface OKXCredentials {
    apiKey: string
    apiSecret: string
    apiPassphrase: string
    baseUrl?: string
    demoTrading: boolean
}

export interface OKXPublicTime {
    ts: string
}

export interface OKXAccountConfig {
    acctLv: string
    posMode: string
}

export interface OKXAccountBalanceDetail {
    ccy: string
    availBal?: string
    availEq?: string
    cashBal?: string
    eq?: string
    eqUsd?: string
}

export interface OKXAccountBalance {
    totalEq: string
    upl: string
    imr?: string
    mmr?: string
    availEq?: string
    adjEq?: string
    details: OKXAccountBalanceDetail[]
}

export interface OKXPosition {
    instId: string
    instType: string
    posId?: string
    pos: string
    posSide: string
    avgPx: string
    markPx: string
    upl: string
    lever?: string
    imr?: string
    margin?: string
    mmr?: string
    mgnMode: string
    liqPx?: string
    cTime?: string
    uTime?: string
}

export interface OKXFill {
    instId: string
    tradeId: string
    ordId: string
    clOrdId?: string
    posId?: string
    billId?: string
    side: "buy" | "sell"
    posSide?: string
    reduceOnly?: string
    fillSz: string
    fillPx: string
    fillPnl?: string
    fee?: string
    feeCcy?: string
    execType?: string
    subType?: string
    ts: string
}

export interface OKXInstrument {
    instId: string
    instType: string
    state: string
    baseCcy?: string
    quoteCcy?: string
    settleCcy?: string
    ctVal: string
    ctValCcy?: string
    ctMult?: string
    lotSz: string
    minSz: string
    tickSz: string
    lever?: string
    ctType?: string
}

export interface OKXOrder {
    instId: string
    ordId: string
    clOrdId?: string
    state: string
    ordType: string
    side: "buy" | "sell"
    sz: string
    accFillSz: string
    px: string
    avgPx: string
    reduceOnly?: string
    posSide?: string
    tdMode?: string
    cTime?: string
    uTime?: string
    fee?: string
    feeCcy?: string
    pnl?: string
    tradeId?: string
    slTriggerPx?: string
    tpTriggerPx?: string
}

export interface OKXAlgoOrder {
    algoId: string
    algoClOrdId?: string
    actualOrdId?: string
    instId: string
    ordType: string
    side: "buy" | "sell"
    posSide?: string
    slTriggerPx?: string
    tpTriggerPx?: string
    cTime?: string
    uTime?: string
    state?: string
}

export interface OKXAccountBill {
    billId: string
    instId?: string
    ccy: string
    amt: string
    type: string
    subType?: string
    ts: string
}

export interface OKXOrderAck {
    ordId: string
    clOrdId?: string
    sCode: string
    sMsg: string
}

export interface OKXAlgoOrderAck {
    algoId: string
    algoClOrdId?: string
    sCode: string
    sMsg: string
}

export type OKXOrderBookLevel = [string, string, string, string]

export interface OKXOrderBook {
    asks: OKXOrderBookLevel[]
    bids: OKXOrderBookLevel[]
    ts: string
}

export interface OKXTicker {
    instId: string
    bidPx: string
    askPx: string
    last: string
    ts: string
}

export interface OKXMarkPrice {
    instId: string
    markPx: string
    ts: string
}

export interface OKXFundingRate {
    instId: string
    fundingRate: string
    nextFundingRate?: string
    fundingTime: string
    nextFundingTime?: string
}

export interface OKXPlaceOrderParams {
    instId: string
    clOrdId?: string
    tdMode: OKXMarginMode
    side: "buy" | "sell"
    ordType: Exclude<OKXOrderType, "conditional">
    sz: string
    px?: string
    posSide?: OKXApiPosSide
    reduceOnly?: boolean
    attachAlgoOrds?: OKXAttachedAlgoOrderParams[]
}

export interface OKXAmendOrderParams {
    instId: string
    ordId: string
    clOrdId?: string
    newSz?: string
    newPx?: string
}

export interface OKXSetLeverageParams {
    instId: string
    lever: string
    mgnMode: OKXMarginMode
    posSide?: Exclude<OKXApiPosSide, "net">
}

export interface OKXPlaceAlgoOrderParams {
    instId: string
    algoClOrdId?: string
    tdMode: OKXMarginMode
    side: "buy" | "sell"
    posSide?: OKXApiPosSide
    ordType: "conditional" | "oco"
    sz: string
    slTriggerPx?: string
    slOrdPx?: string
    tpTriggerPx?: string
    tpOrdPx?: string
}

export type OKXAlgoOrderType = "conditional" | "oco"

export interface OKXAttachedAlgoOrderParams {
    attachAlgoClOrdId?: string
    slTriggerPx?: string
    slOrdPx?: string
    tpTriggerPx?: string
    tpOrdPx?: string
}

export interface OKXCancelAlgoOrderParams {
    algoId: string
    instId: string
}
