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
            "POLYMARKET_SIGNATURE_TYPE",
            "POLYMARKET_FUNDER_ADDRESS",
            "VALIQ_DATA_API_URL",
            "VALIQ_DATA_API",
        ]
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const credentials = this.resolveValidationCredentials(secrets)

        const client = new PolymarketClient(credentials)
        const balance = await client.getBalance()

        if (balance > 0 || client.getSignatureType() !== 0) {
            return
        }

        for (const signatureType of [1, 2] as const) {
            const proxyBalance = await client.getBalanceAllowance({
                assetType: "COLLATERAL",
                signatureType,
            })

            if (Number(proxyBalance?.balance ?? "0") > 0) {
                throw new Error(
                    `Detected Polymarket balance under signature type ${signatureType}. Set POLYMARKET_SIGNATURE_TYPE=${signatureType} and POLYMARKET_FUNDER_ADDRESS to your Polymarket profile wallet address.`
                )
            }
        }
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
        const dataApiKey = config.secrets.VALIQ_DATA_API

        if (!dataApiUrl || !dataApiKey) {
            const missing = [
                !dataApiUrl ? "VALIQ_DATA_API_URL" : null,
                !dataApiKey ? "VALIQ_DATA_API" : null,
            ].filter(Boolean)
            config.runLogger.warn(
                "Valiq tools NOT registered: missing secrets",
                { missing }
            )
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
            signatureType: parseSignatureType(secrets.POLYMARKET_SIGNATURE_TYPE),
            funderAddress: secrets.POLYMARKET_FUNDER_ADDRESS ?? undefined,
        }
    }

    private resolveValidationCredentials(
        secrets: Record<string, string | null>
    ): PolymarketCredentials {
        return this.resolveCredentials(secrets)
    }
}

function parseSignatureType(
    value: string | null | undefined
): 0 | 1 | 2 | undefined {
    if (!value) {
        return undefined
    }

    const parsed = Number(value)

    if (parsed === 0 || parsed === 1 || parsed === 2) {
        return parsed
    }

    throw new Error("POLYMARKET_SIGNATURE_TYPE must be 0, 1, or 2")
}
