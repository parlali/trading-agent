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

export interface BreakingNewsArticle {
    time: string
    title: string
    description: string
    publisher: string
    url: string
    sentiment_finbert: number
    confidence_finbert: number
}

export interface BreakingNewsSummary {
    window: string
    total_count: number
    avg_sentiment_finbert: number
    by_source: Array<{
        source: string
        count: number
        avg_sentiment_finbert: number
    }>
}

export interface BreakingNewsResponse {
    articles: BreakingNewsArticle[]
    summary: BreakingNewsSummary
}

export type BreakingNewsWindow = "1h" | "6h" | "24h" | "prev_24h" | "7d"
export type BreakingNewsSource = "general" | "forex" | "crypto"

export interface BreakingNewsParams {
    window?: BreakingNewsWindow
    source?: BreakingNewsSource
}
