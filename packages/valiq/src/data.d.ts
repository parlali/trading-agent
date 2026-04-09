import type { ValiqDataClient } from "./client";
import type { EquityOverview, EquityPerformanceResponse, EquityFinancialsResponse, EquityFinancialsParams, EquityRatiosResponse, EquityRatiosParams, EquityFundamentalsResponse, EquityFundamentalsParams, EquityBetaResponse, EquityBetaParams, EquityNewsResponse, EquityNewsParams, EquitySentimentResponse, EquitySentimentParams, EquityAnalystRatingsResponse, EquityAnalystTargetsResponse, EquityAnalystParams, ScreeningRequest, ScreeningResponse, MacroEconomyResponse, MacroEconomyParams, MacroGrowthResponse, MacroYearsBackParams, MacroInflationResponse, MacroLaborResponse, MacroStabilityResponse, MacroMoneySupplyResponse, MacroEnergyResponse, MacroOilResponse, MacroGasResponse, MacroEventsResponse, MacroEventsParams, MacroNewsResponse, MacroNewsParams, MacroAnalysisResponse, MacroAnalysisParams, MacroRiskFreeRateResponse, MacroRiskFreeRateParams, BreakingNewsResponse, BreakingNewsParams } from "./types";
export declare class ValiqDataAdapter {
    private client;
    constructor(client: ValiqDataClient);
    getEquityOverview(ticker: string): Promise<EquityOverview>;
    getPerformance(ticker: string, cutoff?: string): Promise<EquityPerformanceResponse>;
    getFinancials(ticker: string, params?: EquityFinancialsParams): Promise<EquityFinancialsResponse>;
    getRatios(ticker: string, params?: EquityRatiosParams): Promise<EquityRatiosResponse>;
    getFundamentals(ticker: string, params?: EquityFundamentalsParams): Promise<EquityFundamentalsResponse>;
    getBeta(ticker: string, params?: EquityBetaParams): Promise<EquityBetaResponse>;
    getNews(ticker: string, params?: EquityNewsParams): Promise<EquityNewsResponse>;
    getSentiment(ticker: string, params?: EquitySentimentParams): Promise<EquitySentimentResponse>;
    getAnalystRatings(ticker: string, params?: EquityAnalystParams): Promise<EquityAnalystRatingsResponse>;
    getAnalystTargets(ticker: string, params?: EquityAnalystParams): Promise<EquityAnalystTargetsResponse>;
    screenAssets(criteria: ScreeningRequest): Promise<ScreeningResponse>;
    getMacroEconomy(region: string, params?: MacroEconomyParams): Promise<MacroEconomyResponse>;
    getMacroGrowth(region: string, params?: MacroYearsBackParams): Promise<MacroGrowthResponse>;
    getMacroInflation(region: string, params?: MacroYearsBackParams): Promise<MacroInflationResponse>;
    getMacroLabor(region: string, params?: MacroYearsBackParams): Promise<MacroLaborResponse>;
    getMacroStability(region: string, params?: MacroYearsBackParams): Promise<MacroStabilityResponse>;
    getMacroMoneySupply(region: string, params?: MacroYearsBackParams & {
        currencies?: string;
    }): Promise<MacroMoneySupplyResponse>;
    getMacroEnergy(region: string, params?: MacroYearsBackParams & {
        metrics?: string;
    }): Promise<MacroEnergyResponse>;
    getMacroOil(region: string, params?: MacroYearsBackParams): Promise<MacroOilResponse>;
    getMacroGas(region: string, params?: MacroYearsBackParams): Promise<MacroGasResponse>;
    getMacroEvents(region: string, params?: MacroEventsParams): Promise<MacroEventsResponse>;
    getMacroNews(region: string, params?: MacroNewsParams): Promise<MacroNewsResponse>;
    getMacroAnalysis(region: string, params?: MacroAnalysisParams): Promise<MacroAnalysisResponse>;
    getMacroRiskFreeRate(region: string, params: MacroRiskFreeRateParams): Promise<MacroRiskFreeRateResponse>;
    getBreakingNews(params?: BreakingNewsParams): Promise<BreakingNewsResponse>;
}
//# sourceMappingURL=data.d.ts.map