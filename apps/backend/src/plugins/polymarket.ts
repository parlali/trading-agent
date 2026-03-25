import type { ToolDefinition } from "@valiq-trading/agent"
import type { RiskValidator, VenueAdapter } from "@valiq-trading/core"
import { PolymarketClient, type PolymarketCredentials } from "../../../polymarket/src/polymarket-client"
import { polymarketRiskValidators } from "../../../polymarket/src/risk-rules"
import { PolymarketVenueAdapter } from "../../../polymarket/src/venue-adapter"
import type { VenuePlugin, ExtraToolsConfig, VenueApp } from "../types"

export class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket"
    readonly venueName = "polymarket"

    private additionalSecrets: Record<string, string | null> = {}

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

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const privateKey = secrets.POLYMARKET_PRIVATE_KEY
        const apiKey = secrets.POLYMARKET_API_KEY
        const apiSecret = secrets.POLYMARKET_API_SECRET
        const apiPassphrase = secrets.POLYMARKET_API_PASSPHRASE

        if (!privateKey || !apiKey || !apiSecret || !apiPassphrase) {
            throw new Error("Polymarket credentials not found in resolved secrets")
        }

        const credentials: PolymarketCredentials = {
            privateKey,
            apiKey,
            apiSecret,
            apiPassphrase,
            host: secrets.POLYMARKET_HOST ?? undefined,
            chainId: secrets.POLYMARKET_CHAIN_ID ? Number(secrets.POLYMARKET_CHAIN_ID) : undefined,
        }

        const client = new PolymarketClient(credentials)
        await client.getBalance()
    }

    createVenueAdapter(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const mergedSecrets = { ...secrets, ...this.additionalSecrets }
        const credentials = this.resolveCredentials(policy, mergedSecrets)
        const client = new PolymarketClient(credentials)
        return new PolymarketVenueAdapter(client)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return polymarketRiskValidators
    }

    getExtraTools(_config: ExtraToolsConfig): ToolDefinition[] {
        return []
    }

    resolveAdditionalCredentialKeys(policy: Record<string, unknown>): string[] {
        const credentialsRef = String(policy.credentialsRef ?? "").trim()
        if (!credentialsRef) return []

        const prefix = credentialsRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
        return [
            `POLYMARKET_${prefix}_PRIVATE_KEY`,
            `POLYMARKET_${prefix}_API_KEY`,
            `POLYMARKET_${prefix}_API_SECRET`,
            `POLYMARKET_${prefix}_API_PASSPHRASE`,
            `POLYMARKET_${prefix}_HOST`,
            `POLYMARKET_${prefix}_CHAIN_ID`,
        ]
    }

    setAdditionalSecrets(secrets: Record<string, string | null>): void {
        this.additionalSecrets = secrets
    }

    private resolveCredentials(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): PolymarketCredentials {
        const credentialsRef = String(policy.credentialsRef ?? "").trim()

        if (!credentialsRef) {
            throw new Error("Polymarket policy credentialsRef is required")
        }

        const prefix = credentialsRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

        const privateKey = secrets[`POLYMARKET_${prefix}_PRIVATE_KEY`] ?? secrets.POLYMARKET_PRIVATE_KEY
        const apiKey = secrets[`POLYMARKET_${prefix}_API_KEY`] ?? secrets.POLYMARKET_API_KEY
        const apiSecret = secrets[`POLYMARKET_${prefix}_API_SECRET`] ?? secrets.POLYMARKET_API_SECRET
        const apiPassphrase = secrets[`POLYMARKET_${prefix}_API_PASSPHRASE`] ?? secrets.POLYMARKET_API_PASSPHRASE

        if (!privateKey) throw new Error(`Missing Polymarket private key for ${credentialsRef}`)
        if (!apiKey) throw new Error(`Missing Polymarket API key for ${credentialsRef}`)
        if (!apiSecret) throw new Error(`Missing Polymarket API secret for ${credentialsRef}`)
        if (!apiPassphrase) throw new Error(`Missing Polymarket API passphrase for ${credentialsRef}`)

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
