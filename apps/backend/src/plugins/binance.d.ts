import type { ToolDefinition } from "@valiq-trading/agent";
import { type RiskValidator, type VenueAdapter } from "@valiq-trading/core";
import type { VenuePlugin, ExtraToolsConfig, PostRunHookConfig, PreRunHookConfig, PreRunHookResult } from "../types";
export declare class BinancePlugin implements VenuePlugin {
    readonly app = "binance-futures";
    readonly venueName = "binance-futures";
    resolveSecretKeys(): string[];
    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[];
    validateEnvironment(secrets: Record<string, string | null>): Promise<void>;
    createVenueAdapter(_policy: Record<string, unknown>, secrets: Record<string, string | null>): VenueAdapter;
    getRiskValidators(): readonly RiskValidator[];
    getExtraTools(config: ExtraToolsConfig): ToolDefinition[];
    preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult>;
    postRunHooks(config: PostRunHookConfig): Promise<void>;
    private checkEmergencyFlatten;
    private checkEndOfSessionFlatten;
    private buildRuntimeContextLines;
}
//# sourceMappingURL=binance.d.ts.map