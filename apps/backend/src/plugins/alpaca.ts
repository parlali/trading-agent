import {
    ALPACA_RUNTIME_SECRET_KEYS,
    AlpacaClient,
    alpacaRiskValidators,
    AlpacaOptionsVenueAdapter,
    resolveAlpacaRuntimeConfig,
} from "@valiq-trading/alpaca-options"
import {
    ExecutionCostTracker,
    type RiskValidator,
    type VenueAdapter,
} from "@valiq-trading/core"
import type { VenuePlugin, ExtraToolsConfig } from "../types"
import {
    appendValiqSecretKeys,
    createValiqTools,
} from "./shared"

export class AlpacaPlugin implements VenuePlugin {
    readonly app = "alpaca-options"
    readonly venueName = "alpaca"

    private environment?: "paper" | "live"
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return appendValiqSecretKeys(ALPACA_RUNTIME_SECRET_KEYS)
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const runtimeConfig = resolveAlpacaRuntimeConfig(secrets)
        this.environment = runtimeConfig.environment

        const client = new AlpacaClient(runtimeConfig)
        await client.getAccount()
        await client.getOptionContracts({
            underlyingSymbol: "SPY",
            limit: 1,
        })
        await client.getLatestEquityQuote("SPY")
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const runtimeConfig = resolveAlpacaRuntimeConfig(secrets)
        const client = new AlpacaClient(runtimeConfig)
        return new AlpacaOptionsVenueAdapter(client, this.executionCostTracker)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return alpacaRiskValidators
    }

    getExtraTools(config: ExtraToolsConfig) {
        return createValiqTools(config, {
            research: true,
            data: true,
        })
    }

    getEnvironment(): "paper" | "live" | undefined {
        return this.environment
    }
}
