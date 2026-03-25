import type { ToolDefinition } from "@valiq-trading/agent"
import { createValiqDataTool, createValiqResearchTool, ValiqClient, ValiqDataAdapter, ValiqResearchAdapter } from "@valiq-trading/valiq"
import type { RiskValidator, VenueAdapter } from "@valiq-trading/core"
import { AlpacaClient, type AlpacaCredentials } from "../../../alpaca-options/src/alpaca-client"
import { alpacaRiskValidators } from "../../../alpaca-options/src/risk-rules"
import { AlpacaOptionsVenueAdapter } from "../../../alpaca-options/src/venue-adapter"
import type { VenuePlugin, ExtraToolsConfig } from "../types"

const PAPER_URL_PATTERN = /paper/i

export class AlpacaPlugin implements VenuePlugin {
    readonly app = "alpaca-options"
    readonly venueName = "alpaca"

    private environment?: "paper" | "live"

    resolveSecretKeys(): string[] {
        return [
            "ALPACA_API_KEY",
            "ALPACA_SECRET_KEY",
            "ALPACA_BASE_URL",
            "ALPACA_PRIMARY_API_KEY",
            "ALPACA_PRIMARY_SECRET_KEY",
            "ALPACA_PRIMARY_BASE_URL",
            "VALIQ_API_URL",
            "VALIQ_AUTH_TOKEN",
        ]
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const apiKey = secrets.ALPACA_PRIMARY_API_KEY ?? secrets.ALPACA_API_KEY
        const secretKey = secrets.ALPACA_PRIMARY_SECRET_KEY ?? secrets.ALPACA_SECRET_KEY
        const baseUrl = secrets.ALPACA_PRIMARY_BASE_URL ?? secrets.ALPACA_BASE_URL

        if (!apiKey || !secretKey) {
            throw new Error("Alpaca API credentials not found in resolved secrets")
        }

        const credentials: AlpacaCredentials = {
            apiKey,
            secretKey,
            accountId: "",
            baseUrl: baseUrl ?? undefined,
        }

        const effectiveUrl = baseUrl ?? "https://paper-api.alpaca.markets"
        this.environment = PAPER_URL_PATTERN.test(effectiveUrl) ? "paper" : "live"

        const client = new AlpacaClient(credentials)
        await client.getAccount()
    }

    createVenueAdapter(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const credentials = this.resolveCredentials(policy, secrets)
        const client = new AlpacaClient(credentials)
        return new AlpacaOptionsVenueAdapter(client)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return alpacaRiskValidators
    }

    getExtraTools(config: ExtraToolsConfig): ToolDefinition[] {
        const valiqUrl = config.secrets.VALIQ_API_URL
        const valiqToken = config.secrets.VALIQ_AUTH_TOKEN

        if (!valiqUrl || !valiqToken) {
            return []
        }

        const valiqClient = new ValiqClient({
            apiUrl: valiqUrl,
            authToken: valiqToken,
            logger: config.runLogger,
        })
        const research = new ValiqResearchAdapter(valiqClient, config.runLogger)
        const data = new ValiqDataAdapter(valiqClient)

        return [
            createValiqResearchTool(research),
            createValiqDataTool(data),
        ]
    }

    getEnvironment(): "paper" | "live" | undefined {
        return this.environment
    }

    private resolveCredentials(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): AlpacaCredentials {
        const brokerRef = String(policy.broker ?? "").trim()
        const accountId = String(policy.accountId ?? "").trim()

        if (!brokerRef) {
            throw new Error("Alpaca policy broker reference is required")
        }

        if (!accountId) {
            throw new Error("Alpaca policy accountId is required")
        }

        const prefix = brokerRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

        const apiKey = secrets[`ALPACA_${prefix}_API_KEY`] ?? secrets.ALPACA_API_KEY
        const secretKey = secrets[`ALPACA_${prefix}_SECRET_KEY`] ?? secrets.ALPACA_SECRET_KEY

        if (!apiKey) {
            throw new Error(`Missing Alpaca API key for broker ${brokerRef}`)
        }
        if (!secretKey) {
            throw new Error(`Missing Alpaca secret key for broker ${brokerRef}`)
        }

        return {
            apiKey,
            secretKey,
            accountId,
            baseUrl: secrets[`ALPACA_${prefix}_BASE_URL`] ?? secrets.ALPACA_BASE_URL ?? undefined,
        }
    }
}
