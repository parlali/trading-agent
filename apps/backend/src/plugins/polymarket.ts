import type { ToolDefinition } from "@valiq-trading/agent"
import { requireResolvedSecret, type RiskValidator, type VenueAdapter } from "@valiq-trading/core"
import { PolymarketClient, type PolymarketCredentials, polymarketRiskValidators, PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import { createValiqBreakingNewsTool, ValiqDataClient, ValiqDataAdapter } from "@valiq-trading/valiq"
import type { VenuePlugin, ExtraToolsConfig } from "../types"

export class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket"
    readonly venueName = "polymarket"

    resolveSecretKeys(): string[] {
        return [
            "POLYMARKET_PRIVATE_KEY",
            "POLYMARKET_API_KEY",
            "POLYMARKET_API_SECRET",
            "POLYMARKET_API_PASSPHRASE",
            "POLYMARKET_HOST",
            "POLYMARKET_CHAIN_ID",
            "VALIQ_DATA_API_URL",
            "VALIQ_DATA_API_KEY",
        ]
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const credentials = this.resolveValidationCredentials(secrets)

        const client = new PolymarketClient(credentials)
        await client.getBalance()
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const credentials = this.resolveCredentials(secrets)
        const client = new PolymarketClient(credentials)
        return new PolymarketVenueAdapter(client)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return polymarketRiskValidators
    }

    getExtraTools(config: ExtraToolsConfig): ToolDefinition[] {
        const dataApiUrl = config.secrets.VALIQ_DATA_API_URL
        const dataApiKey = config.secrets.VALIQ_DATA_API_KEY

        if (!dataApiUrl || !dataApiKey) {
            return []
        }

        const dataClient = new ValiqDataClient({
            apiUrl: dataApiUrl,
            apiKey: dataApiKey,
            logger: config.runLogger,
        })
        const data = new ValiqDataAdapter(dataClient)

        return [
            createValiqBreakingNewsTool(data),
        ]
    }

    private resolveCredentials(
        secrets: Record<string, string | null>
    ): PolymarketCredentials {
        const privateKey = requireResolvedSecret(secrets, "POLYMARKET_PRIVATE_KEY")
        const apiKey = requireResolvedSecret(secrets, "POLYMARKET_API_KEY")
        const apiSecret = requireResolvedSecret(secrets, "POLYMARKET_API_SECRET")
        const apiPassphrase = requireResolvedSecret(secrets, "POLYMARKET_API_PASSPHRASE")

        return {
            privateKey,
            apiKey,
            apiSecret,
            apiPassphrase,
            host: secrets.POLYMARKET_HOST ?? undefined,
            chainId: secrets.POLYMARKET_CHAIN_ID
                ? Number(secrets.POLYMARKET_CHAIN_ID)
                : undefined,
        }
    }

    private resolveValidationCredentials(
        secrets: Record<string, string | null>
    ): PolymarketCredentials {
        return this.resolveCredentials(secrets)
    }
}
