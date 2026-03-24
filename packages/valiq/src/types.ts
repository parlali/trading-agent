export interface EquityOverview {
    ticker: string
    name: string
    exchange: string
    sector: string
    industry: string
    marketCap: number | null
    latestPrice: number | null
    [key: string]: unknown
}

export interface PriceBar {
    timestamp: string
    open: number
    high: number
    low: number
    close: number
    volume: number
}

export interface EquityPriceResponse {
    ticker: string
    bars: PriceBar[]
    pagination?: {
        nextCursor: string | null
        hasMore: boolean
    }
}

export interface EquityCurrentPriceResponse {
    ticker: string
    latest: PriceBar
    previousDayHigh: number | null
    previousDayLow: number | null
    [key: string]: unknown
}

export interface EquityPerformanceResponse {
    ticker: string
    returns: Record<string, number | null>
    [key: string]: unknown
}

export interface EquityFinancialsResponse {
    ticker: string
    filings: Array<Record<string, unknown>>
}

export interface EquityRatiosResponse {
    ticker: string
    ratios: Record<string, unknown>
    sectorComparison: Record<string, unknown> | null
    [key: string]: unknown
}

export interface EquityFundamentalsResponse {
    ticker: string
    fundamentals: Record<string, unknown>
    sectorComparison: Record<string, unknown> | null
    [key: string]: unknown
}

export interface EquityBetaResponse {
    ticker: string
    betas: Record<string, unknown>
    [key: string]: unknown
}

export interface EquityNewsResponse {
    ticker: string
    articles: Array<{
        title: string
        url: string
        source: string
        publishedAt: string
        snippet: string
        [key: string]: unknown
    }>
}

export interface EquitySentimentResponse {
    ticker: string
    sentiment: Array<Record<string, unknown>>
    [key: string]: unknown
}

export interface EquityAnalystRatingsResponse {
    ticker: string
    ratings: Array<Record<string, unknown>>
    consensus: Record<string, unknown> | null
    [key: string]: unknown
}

export interface EquityAnalystTargetsResponse {
    ticker: string
    targets: Array<Record<string, unknown>>
    statistics: Record<string, unknown> | null
    [key: string]: unknown
}

export interface OptionsChainContract {
    symbol: string
    type: "call" | "put"
    strike: number
    expiration: string
    bid: number | null
    ask: number | null
    lastPrice: number | null
    volume: number | null
    openInterest: number | null
    impliedVolatility: number | null
    delta: number | null
    gamma: number | null
    theta: number | null
    vega: number | null
    [key: string]: unknown
}

export interface OptionsChainResponse {
    ticker: string
    contracts: OptionsChainContract[]
    [key: string]: unknown
}

export interface OptionsIVOverviewResponse {
    ticker: string
    atmIV: number | null
    ivRank: number | null
    ivPercentile: number | null
    termStructure: Array<Record<string, unknown>>
    [key: string]: unknown
}

export interface OptionsScreeningRow {
    ticker: string
    atmIV: number | null
    ivRank: number | null
    ivPercentile: number | null
    [key: string]: unknown
}

export interface OptionsScreeningResponse {
    rows: OptionsScreeningRow[]
}

export interface ScreeningRequest {
    [key: string]: unknown
}

export interface ScreeningResponse {
    assets: Array<Record<string, unknown>>
}

export interface MacroEconomyResponse {
    region: string
    indicators: Record<string, unknown>
}

export interface MacroGrowthResponse {
    region: string
    growth: Record<string, unknown>
}

export interface MacroInflationResponse {
    region: string
    inflation: Record<string, unknown>
}

export interface MacroLaborResponse {
    region: string
    labor: Record<string, unknown>
}

export interface MacroStabilityResponse {
    region: string
    stability: Record<string, unknown>
}

export interface MacroMoneySupplyResponse {
    region: string
    moneySupply: Record<string, unknown>
}

export interface MacroEnergyResponse {
    region: string
    energy: Record<string, unknown>
}

export interface MacroOilResponse {
    region: string
    oil: Record<string, unknown>
}

export interface MacroGasResponse {
    region: string
    gas: Record<string, unknown>
}

export interface MacroEventsResponse {
    region: string
    events: Array<Record<string, unknown>>
}

export interface MacroNewsResponse {
    region: string
    news: Array<Record<string, unknown>>
}

export interface MacroAnalysisResponse {
    region: string
    analysis: string
    [key: string]: unknown
}

export interface MacroRiskFreeRateResponse {
    region: string
    maturity: string
    startDate: string
    endDate: string
    averageRate: number | null
}

export interface ChatResponse {
    id: string
    title: string | null
    [key: string]: unknown
}

export type SSEEventType =
    | "message_created"
    | "timeline_start"
    | "timeline_reasoning"
    | "timeline_tool_call"
    | "timeline_tool_result"
    | "timeline_complete"
    | "task_progress"
    | "final_response"
    | "completion"
    | "error"
    | "heartbeat"
    | "activity"

export interface SSEEvent {
    type: SSEEventType
    timelineId?: string
    sequence?: number
    timestamp?: number
    data?: Record<string, unknown>
}

export interface FinalResponseData {
    content: string
    isComplete: boolean
}

export interface CompletionData {
    messageId: string
    parentId: string | null
    finalContent: string
    status: string
}

export interface ErrorData {
    message: string
    code?: string
}

export interface EquityPriceParams {
    limit?: number
    start?: string
    end?: string
    bucket?: "1H" | "4H" | "day" | "week" | "month"
    cursor?: string
}

export interface EquityFinancialsParams {
    limit?: number
    offset?: number
    fileName?: "10-K" | "10-Q"
}

export interface EquityRatiosParams {
    period?: "annual" | "quarterly"
}

export interface EquityFundamentalsParams {
    fileName?: "10-K" | "10-Q"
}

export interface EquityBetaParams {
    history?: boolean
    limit?: number
}

export interface EquityNewsParams {
    limit?: number
    offset?: number
}

export interface EquitySentimentParams {
    window?: "hour" | "day" | "week" | "month"
}

export interface EquityAnalystParams {
    daysBack?: number
    limit?: number
}

export interface MacroEconomyParams {
    yearsBack?: number
    metrics?: string
}

export interface MacroYearsBackParams {
    yearsBack?: number
}

export interface MacroEventsParams {
    daysForward?: number
    daysBack?: number
    impactFilter?: string
}

export interface MacroNewsParams {
    limit?: number
    daysBack?: number
    table?: "economy" | "energy"
}

export interface MacroAnalysisParams {
    table?: "economy" | "energy"
}

export interface MacroRiskFreeRateParams {
    startDate: string
    endDate: string
}

export interface OptionsChainParams {
    [key: string]: unknown
}

export interface OptionsScreeningParams {
    [key: string]: unknown
}
