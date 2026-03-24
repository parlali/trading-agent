import type { ValiqClient } from "./client"
import type {
    EquityOverview,
    EquityPriceResponse,
    EquityPriceParams,
    EquityCurrentPriceResponse,
    EquityPerformanceResponse,
    EquityFinancialsResponse,
    EquityFinancialsParams,
    EquityRatiosResponse,
    EquityRatiosParams,
    EquityFundamentalsResponse,
    EquityFundamentalsParams,
    EquityBetaResponse,
    EquityBetaParams,
    EquityNewsResponse,
    EquityNewsParams,
    EquitySentimentResponse,
    EquitySentimentParams,
    EquityAnalystRatingsResponse,
    EquityAnalystTargetsResponse,
    EquityAnalystParams,
    OptionsChainResponse,
    OptionsIVOverviewResponse,
    OptionsScreeningResponse,
    OptionsScreeningParams,
    ScreeningRequest,
    ScreeningResponse,
    MacroEconomyResponse,
    MacroEconomyParams,
    MacroGrowthResponse,
    MacroYearsBackParams,
    MacroInflationResponse,
    MacroLaborResponse,
    MacroStabilityResponse,
    MacroMoneySupplyResponse,
    MacroEnergyResponse,
    MacroOilResponse,
    MacroGasResponse,
    MacroEventsResponse,
    MacroEventsParams,
    MacroNewsResponse,
    MacroNewsParams,
    MacroAnalysisResponse,
    MacroAnalysisParams,
    MacroRiskFreeRateResponse,
    MacroRiskFreeRateParams,
} from "./types"

function buildQuery(params: object): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    if (entries.length === 0) return ""
    const searchParams = new URLSearchParams()
    for (const [key, value] of entries) {
        searchParams.set(key, String(value))
    }
    return `?${searchParams.toString()}`
}

export class ValiqDataAdapter {
    constructor(private client: ValiqClient) {}

    async getEquityOverview(ticker: string): Promise<EquityOverview> {
        return this.client.request<EquityOverview>(`/equity/${encodeURIComponent(ticker)}`)
    }

    async getEquityPrice(ticker: string, params?: EquityPriceParams): Promise<EquityPriceResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<EquityPriceResponse>(
            `/equity/${encodeURIComponent(ticker)}/price${query}`
        )
    }

    async getCurrentPrice(ticker: string): Promise<EquityCurrentPriceResponse> {
        return this.client.request<EquityCurrentPriceResponse>(
            `/equity/${encodeURIComponent(ticker)}/price/current`
        )
    }

    async getPerformance(ticker: string, cutoff?: string): Promise<EquityPerformanceResponse> {
        const query = cutoff ? buildQuery({ cutoff }) : ""
        return this.client.request<EquityPerformanceResponse>(
            `/equity/${encodeURIComponent(ticker)}/price/performance${query}`
        )
    }

    async getFinancials(ticker: string, params?: EquityFinancialsParams): Promise<EquityFinancialsResponse> {
        const query = params
            ? buildQuery({ limit: params.limit, offset: params.offset, file_name: params.fileName })
            : ""
        return this.client.request<EquityFinancialsResponse>(
            `/equity/${encodeURIComponent(ticker)}/financials${query}`
        )
    }

    async getRatios(ticker: string, params?: EquityRatiosParams): Promise<EquityRatiosResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<EquityRatiosResponse>(
            `/equity/${encodeURIComponent(ticker)}/ratios${query}`
        )
    }

    async getFundamentals(ticker: string, params?: EquityFundamentalsParams): Promise<EquityFundamentalsResponse> {
        const query = params ? buildQuery({ file_name: params.fileName }) : ""
        return this.client.request<EquityFundamentalsResponse>(
            `/equity/${encodeURIComponent(ticker)}/fundamentals${query}`
        )
    }

    async getBeta(ticker: string, params?: EquityBetaParams): Promise<EquityBetaResponse> {
        const query = params
            ? buildQuery({ history: params.history ? "true" : undefined, limit: params.limit })
            : ""
        return this.client.request<EquityBetaResponse>(
            `/equity/${encodeURIComponent(ticker)}/beta${query}`
        )
    }

    async getNews(ticker: string, params?: EquityNewsParams): Promise<EquityNewsResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<EquityNewsResponse>(
            `/equity/${encodeURIComponent(ticker)}/news${query}`
        )
    }

    async getSentiment(ticker: string, params?: EquitySentimentParams): Promise<EquitySentimentResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<EquitySentimentResponse>(
            `/equity/${encodeURIComponent(ticker)}/sentiment${query}`
        )
    }

    async getAnalystRatings(ticker: string, params?: EquityAnalystParams): Promise<EquityAnalystRatingsResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<EquityAnalystRatingsResponse>(
            `/equity/${encodeURIComponent(ticker)}/analyst/ratings${query}`
        )
    }

    async getAnalystTargets(ticker: string, params?: EquityAnalystParams): Promise<EquityAnalystTargetsResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<EquityAnalystTargetsResponse>(
            `/equity/${encodeURIComponent(ticker)}/analyst/targets${query}`
        )
    }

    async getOptionsChain(ticker: string): Promise<OptionsChainResponse> {
        return this.client.request<OptionsChainResponse>(
            `/options/${encodeURIComponent(ticker)}/chain`
        )
    }

    async getOptionsIV(ticker: string): Promise<OptionsIVOverviewResponse> {
        return this.client.request<OptionsIVOverviewResponse>(
            `/options/${encodeURIComponent(ticker)}/iv`
        )
    }

    async screenOptions(params?: OptionsScreeningParams): Promise<OptionsScreeningResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<OptionsScreeningResponse>(`/options/screening${query}`)
    }

    async screenAssets(criteria: ScreeningRequest): Promise<ScreeningResponse> {
        return this.client.request<ScreeningResponse>("/screening/assets", {
            method: "POST",
            body: JSON.stringify(criteria),
        })
    }

    async getMacroEconomy(region: string, params?: MacroEconomyParams): Promise<MacroEconomyResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroEconomyResponse>(
            `/macro/${encodeURIComponent(region)}/economy${query}`
        )
    }

    async getMacroGrowth(region: string, params?: MacroYearsBackParams): Promise<MacroGrowthResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroGrowthResponse>(
            `/macro/${encodeURIComponent(region)}/economy/growth${query}`
        )
    }

    async getMacroInflation(region: string, params?: MacroYearsBackParams): Promise<MacroInflationResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroInflationResponse>(
            `/macro/${encodeURIComponent(region)}/economy/inflation${query}`
        )
    }

    async getMacroLabor(region: string, params?: MacroYearsBackParams): Promise<MacroLaborResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroLaborResponse>(
            `/macro/${encodeURIComponent(region)}/economy/labor${query}`
        )
    }

    async getMacroStability(region: string, params?: MacroYearsBackParams): Promise<MacroStabilityResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroStabilityResponse>(
            `/macro/${encodeURIComponent(region)}/economy/stability${query}`
        )
    }

    async getMacroMoneySupply(
        region: string,
        params?: MacroYearsBackParams & { currencies?: string }
    ): Promise<MacroMoneySupplyResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroMoneySupplyResponse>(
            `/macro/${encodeURIComponent(region)}/economy/money-supply${query}`
        )
    }

    async getMacroEnergy(
        region: string,
        params?: MacroYearsBackParams & { metrics?: string }
    ): Promise<MacroEnergyResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroEnergyResponse>(
            `/macro/${encodeURIComponent(region)}/energy${query}`
        )
    }

    async getMacroOil(region: string, params?: MacroYearsBackParams): Promise<MacroOilResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroOilResponse>(
            `/macro/${encodeURIComponent(region)}/energy/oil${query}`
        )
    }

    async getMacroGas(region: string, params?: MacroYearsBackParams): Promise<MacroGasResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroGasResponse>(
            `/macro/${encodeURIComponent(region)}/energy/gas${query}`
        )
    }

    async getMacroEvents(region: string, params?: MacroEventsParams): Promise<MacroEventsResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroEventsResponse>(
            `/macro/${encodeURIComponent(region)}/events${query}`
        )
    }

    async getMacroNews(region: string, params?: MacroNewsParams): Promise<MacroNewsResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroNewsResponse>(
            `/macro/${encodeURIComponent(region)}/news${query}`
        )
    }

    async getMacroAnalysis(region: string, params?: MacroAnalysisParams): Promise<MacroAnalysisResponse> {
        const query = params ? buildQuery(params) : ""
        return this.client.request<MacroAnalysisResponse>(
            `/macro/${encodeURIComponent(region)}/analysis${query}`
        )
    }

    async getMacroRiskFreeRate(region: string, params: MacroRiskFreeRateParams): Promise<MacroRiskFreeRateResponse> {
        const query = buildQuery(params)
        return this.client.request<MacroRiskFreeRateResponse>(
            `/macro/${encodeURIComponent(region)}/rates/risk-free${query}`
        )
    }
}
