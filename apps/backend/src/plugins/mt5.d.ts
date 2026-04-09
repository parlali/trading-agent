import type { ToolDefinition } from "@valiq-trading/agent";
import { type RiskValidator, type VenueAdapter } from "@valiq-trading/core";
import type { VenuePlugin, ExtraToolsConfig, PreRunHookConfig, PreRunHookResult, PostRunHookConfig } from "../types";
export declare class MT5Plugin implements VenuePlugin {
    readonly app = "mt5";
    readonly venueName = "mt5";
    private readonly holidayGuard;
    resolveSecretKeys(): string[];
    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[];
    validateEnvironment(secrets: Record<string, string | null>): Promise<void>;
    createVenueAdapter(_policy: Record<string, unknown>, secrets: Record<string, string | null>): VenueAdapter;
    getRiskValidators(): readonly RiskValidator[];
    getExtraTools(config: ExtraToolsConfig): ToolDefinition[];
    preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult>;
    postRunHooks(config: PostRunHookConfig): Promise<void>;
    private checkEmergencyFlatten;
    private checkEndOfDayFlatten;
    private buildRuntimeContextLines;
}
//# sourceMappingURL=mt5.d.ts.map