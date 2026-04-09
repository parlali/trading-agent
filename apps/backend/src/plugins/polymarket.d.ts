import type { ToolDefinition } from "@valiq-trading/agent";
import { type RiskValidator, type VenueAdapter } from "@valiq-trading/core";
import type { VenuePlugin, ExtraToolsConfig } from "../types";
export declare class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket";
    readonly venueName = "polymarket";
    resolveSecretKeys(): string[];
    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[];
    validateEnvironment(secrets: Record<string, string | null>): Promise<void>;
    createVenueAdapter(_policy: Record<string, unknown>, secrets: Record<string, string | null>): VenueAdapter;
    getRiskValidators(): readonly RiskValidator[];
    getExtraTools(config: ExtraToolsConfig): ToolDefinition[];
}
//# sourceMappingURL=polymarket.d.ts.map