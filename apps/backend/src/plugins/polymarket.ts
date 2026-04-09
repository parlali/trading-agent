import type { ToolDefinition } from "@valiq-trading/agent"
import { type RiskValidator, type VenueAdapter } from "@valiq-trading/core"
import {
    PolymarketClient,
    polymarketRiskValidators,
    POLYMARKET_RUNTIME_SECRET_KEYS,
    PolymarketVenueAdapter,
    resolvePolymarketCredentials,
} from "@valiq-trading/polymarket"
import {
    createValiqBreakingNewsTool,
    VALIQ_DATA_SECRET_KEYS,
    getMissingValiqDataApiSecrets,
    resolveValiqDataApiConfig,
    ValiqDataClient,
    ValiqDataAdapter,
} from "@valiq-trading/valiq"
import type { VenuePlugin, ExtraToolsConfig } from "../types"

export class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket"
    readonly venueName = "polymarket"

    resolveSecretKeys(): string[] {
        return [
            ...POLYMARKET_RUNTIME_SECRET_KEYS,
            ...VALIQ_DATA_SECRET_KEYS,
        ]
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const credentials = resolvePolymarketCredentials(secrets)
        const client = new PolymarketClient(credentials)
        await client.getBalance()
        await client.getOpenOrders()
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const credentials = resolvePolymarketCredentials(secrets)
        const client = new PolymarketClient(credentials)
        return new PolymarketVenueAdapter(client)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return polymarketRiskValidators
    }

    getExtraTools(config: ExtraToolsConfig): ToolDefinition[] {
        const dataApi = resolveValiqDataApiConfig(config.secrets)

        if (!dataApi) {
            const missing = getMissingValiqDataApiSecrets(config.secrets)
            config.runLogger.warn(
                "Valiq tools NOT registered: missing secrets",
                { missing }
            )
            return []
        }

        const dataClient = new ValiqDataClient({
            apiUrl: dataApi.apiUrl,
            apiKey: dataApi.apiKey,
            logger: config.runLogger,
        })
        const data = new ValiqDataAdapter(dataClient)

        return [
            createValiqBreakingNewsTool(data),
        ]
    }
}
