import type { ToolDefinition } from "@valiq-trading/agent"
import { createValiqDataTool, createValiqResearchTool, ValiqClient, ValiqDataAdapter, ValiqResearchAdapter } from "@valiq-trading/valiq"
import { AlpacaClient, type AlpacaCredentials, alpacaRiskValidators, AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import { requireResolvedSecret, resolveCredentialPrefix, type RiskValidator, type VenueAdapter } from "@valiq-trading/core"
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

    resolveAdditionalSecretKeys(policy: Record<string, unknown>): string[] {
        const brokerRef = String(policy.broker ?? "").trim()
        if (!brokerRef) {
            return []
        }

        const prefix = resolveCredentialPrefix(brokerRef)

        return [
            `ALPACA_${prefix}_API_KEY`,
            `ALPACA_${prefix}_SECRET_KEY`,
            `ALPACA_${prefix}_BASE_URL`,
        ]
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const credentials = this.resolveValidationCredentials(secrets)
        const effectiveUrl = credentials.baseUrl ?? "https://paper-api.alpaca.markets"
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

        const prefix = resolveCredentialPrefix(brokerRef)
        const apiKey = requireResolvedSecret(secrets, `ALPACA_${prefix}_API_KEY`, "ALPACA_API_KEY")
        const secretKey = requireResolvedSecret(secrets, `ALPACA_${prefix}_SECRET_KEY`, "ALPACA_SECRET_KEY")

        return {
            apiKey,
            secretKey,
            accountId,
            baseUrl: secrets[`ALPACA_${prefix}_BASE_URL`] ?? secrets.ALPACA_BASE_URL ?? undefined,
        }
    }

    private resolveValidationCredentials(
        secrets: Record<string, string | null>
    ): AlpacaCredentials {
        if (secrets.ALPACA_PRIMARY_API_KEY && secrets.ALPACA_PRIMARY_SECRET_KEY) {
            return {
                apiKey: secrets.ALPACA_PRIMARY_API_KEY,
                secretKey: secrets.ALPACA_PRIMARY_SECRET_KEY,
                accountId: "",
                baseUrl: secrets.ALPACA_PRIMARY_BASE_URL ?? secrets.ALPACA_BASE_URL ?? undefined,
            }
        }

        if (secrets.ALPACA_API_KEY && secrets.ALPACA_SECRET_KEY) {
            return {
                apiKey: secrets.ALPACA_API_KEY,
                secretKey: secrets.ALPACA_SECRET_KEY,
                accountId: "",
                baseUrl: secrets.ALPACA_BASE_URL ?? undefined,
            }
        }

        for (const key of Object.keys(secrets)) {
            const match = key.match(/^ALPACA_(.+)_API_KEY$/)
            if (!match) {
                continue
            }

            const prefix = match[1]
            const apiKey = secrets[key]
            const secretKey = secrets[`ALPACA_${prefix}_SECRET_KEY`]

            if (apiKey && secretKey) {
                return {
                    apiKey,
                    secretKey,
                    accountId: "",
                    baseUrl: secrets[`ALPACA_${prefix}_BASE_URL`] ?? secrets.ALPACA_BASE_URL ?? undefined,
                }
            }
        }

        throw new Error("Alpaca API credentials not found in resolved secrets")
    }
}
