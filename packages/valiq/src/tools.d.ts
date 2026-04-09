import type { ToolDefinition } from "@valiq-trading/agent";
import type { ValiqDataAdapter } from "./data";
import type { ValiqResearchAdapter } from "./research";
export declare function createValiqResearchTool(research: ValiqResearchAdapter): ToolDefinition;
export declare function createValiqBreakingNewsTool(data: ValiqDataAdapter): ToolDefinition;
declare const dataEndpoints: readonly ["getEquityOverview", "getPerformance", "getFinancials", "getRatios", "getFundamentals", "getBeta", "getNews", "getSentiment", "getAnalystRatings", "getAnalystTargets", "screenAssets", "getMacroEconomy", "getMacroGrowth", "getMacroInflation", "getMacroLabor", "getMacroStability", "getMacroMoneySupply", "getMacroEnergy", "getMacroOil", "getMacroGas", "getMacroEvents", "getMacroNews", "getMacroAnalysis", "getMacroRiskFreeRate", "getBreakingNews"];
export type ValiqDataEndpoint = (typeof dataEndpoints)[number];
export declare function createValiqDataTool(data: ValiqDataAdapter): ToolDefinition;
export {};
//# sourceMappingURL=tools.d.ts.map