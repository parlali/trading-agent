import type { ToolDefinition } from "@valiq-trading/agent";
import type { RiskValidator, VenueAdapter } from "@valiq-trading/core";
import type { VenuePlugin, ExtraToolsConfig } from "../types";
export declare class AlpacaPlugin implements VenuePlugin {
    readonly app = "alpaca-options";
    readonly venueName = "alpaca";
    private environment?;
    resolveSecretKeys(): string[];
    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[];
    validateEnvironment(secrets: Record<string, string | null>): Promise<void>;
    createVenueAdapter(_policy: Record<string, unknown>, secrets: Record<string, string | null>): VenueAdapter;
    getRiskValidators(): readonly RiskValidator[];
    getExtraTools(config: ExtraToolsConfig): ToolDefinition[];
    getEnvironment(): "paper" | "live" | undefined;
}
//# sourceMappingURL=alpaca.d.ts.map