import type { ToolDefinition } from "@valiq-trading/agent"
import { requireResolvedSecret, resolveCredentialPrefix, type RiskValidator, type VenueAdapter } from "@valiq-trading/core"
import { PolymarketClient, type PolymarketCredentials, polymarketRiskValidators, PolymarketVenueAdapter } from "@valiq-trading/polymarket"
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
        ]
    }

    resolveAdditionalSecretKeys(policy: Record<string, unknown>): string[] {
        const credentialsRef = String(policy.credentialsRef ?? "").trim()
        if (!credentialsRef) return []

        const prefix = resolveCredentialPrefix(credentialsRef)
        return [
            `POLYMARKET_${prefix}_PRIVATE_KEY`,
            `POLYMARKET_${prefix}_API_KEY`,
            `POLYMARKET_${prefix}_API_SECRET`,
            `POLYMARKET_${prefix}_API_PASSPHRASE`,
            `POLYMARKET_${prefix}_HOST`,
            `POLYMARKET_${prefix}_CHAIN_ID`,
        ]
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const credentials = this.resolveValidationCredentials(secrets)

        const client = new PolymarketClient(credentials)
        await client.getBalance()
    }

    createVenueAdapter(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const credentials = this.resolveCredentials(policy, secrets)
        const client = new PolymarketClient(credentials)
        return new PolymarketVenueAdapter(client)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return polymarketRiskValidators
    }

    getExtraTools(_config: ExtraToolsConfig): ToolDefinition[] {
        return []
    }

    private resolveCredentials(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): PolymarketCredentials {
        const credentialsRef = String(policy.credentialsRef ?? "").trim()

        if (!credentialsRef) {
            throw new Error("Polymarket policy credentialsRef is required")
        }

        const prefix = resolveCredentialPrefix(credentialsRef)
        const privateKey = requireResolvedSecret(
            secrets,
            `POLYMARKET_${prefix}_PRIVATE_KEY`,
            "POLYMARKET_PRIVATE_KEY"
        )
        const apiKey = requireResolvedSecret(
            secrets,
            `POLYMARKET_${prefix}_API_KEY`,
            "POLYMARKET_API_KEY"
        )
        const apiSecret = requireResolvedSecret(
            secrets,
            `POLYMARKET_${prefix}_API_SECRET`,
            "POLYMARKET_API_SECRET"
        )
        const apiPassphrase = requireResolvedSecret(
            secrets,
            `POLYMARKET_${prefix}_API_PASSPHRASE`,
            "POLYMARKET_API_PASSPHRASE"
        )

        return {
            privateKey,
            apiKey,
            apiSecret,
            apiPassphrase,
            host: secrets[`POLYMARKET_${prefix}_HOST`] ?? secrets.POLYMARKET_HOST ?? undefined,
            chainId: secrets[`POLYMARKET_${prefix}_CHAIN_ID`]
                ? Number(secrets[`POLYMARKET_${prefix}_CHAIN_ID`])
                : secrets.POLYMARKET_CHAIN_ID
                    ? Number(secrets.POLYMARKET_CHAIN_ID)
                    : undefined,
        }
    }

    private resolveValidationCredentials(
        secrets: Record<string, string | null>
    ): PolymarketCredentials {
        if (
            secrets.POLYMARKET_PRIVATE_KEY &&
            secrets.POLYMARKET_API_KEY &&
            secrets.POLYMARKET_API_SECRET &&
            secrets.POLYMARKET_API_PASSPHRASE
        ) {
            return {
                privateKey: secrets.POLYMARKET_PRIVATE_KEY,
                apiKey: secrets.POLYMARKET_API_KEY,
                apiSecret: secrets.POLYMARKET_API_SECRET,
                apiPassphrase: secrets.POLYMARKET_API_PASSPHRASE,
                host: secrets.POLYMARKET_HOST ?? undefined,
                chainId: secrets.POLYMARKET_CHAIN_ID ? Number(secrets.POLYMARKET_CHAIN_ID) : undefined,
            }
        }

        for (const key of Object.keys(secrets)) {
            const match = key.match(/^POLYMARKET_(.+)_PRIVATE_KEY$/)
            if (!match) {
                continue
            }

            const prefix = match[1]
            const privateKey = secrets[key]
            const apiKey = secrets[`POLYMARKET_${prefix}_API_KEY`]
            const apiSecret = secrets[`POLYMARKET_${prefix}_API_SECRET`]
            const apiPassphrase = secrets[`POLYMARKET_${prefix}_API_PASSPHRASE`]

            if (privateKey && apiKey && apiSecret && apiPassphrase) {
                return {
                    privateKey,
                    apiKey,
                    apiSecret,
                    apiPassphrase,
                    host: secrets[`POLYMARKET_${prefix}_HOST`] ?? secrets.POLYMARKET_HOST ?? undefined,
                    chainId: secrets[`POLYMARKET_${prefix}_CHAIN_ID`]
                        ? Number(secrets[`POLYMARKET_${prefix}_CHAIN_ID`])
                        : secrets.POLYMARKET_CHAIN_ID
                            ? Number(secrets.POLYMARKET_CHAIN_ID)
                            : undefined,
                }
            }
        }

        throw new Error("Polymarket credentials not found in resolved secrets")
    }
}
