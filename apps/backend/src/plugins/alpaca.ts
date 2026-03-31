import type { ToolDefinition } from "@valiq-trading/agent"
import { createValiqDataTool, createValiqResearchTool, ValiqClient, ValiqDataClient, ValiqDataAdapter, ValiqResearchAdapter, createOAuthTokenProvider } from "@valiq-trading/valiq"
import { AlpacaClient, type AlpacaCredentials, alpacaRiskValidators, AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import { requireResolvedSecret, type RiskValidator, type VenueAdapter } from "@valiq-trading/core"
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
            "ALPACA_ACCOUNT_ID",
            "ALPACA_PRIMARY_API_KEY",
            "ALPACA_PRIMARY_SECRET_KEY",
            "ALPACA_PRIMARY_BASE_URL",
            "VALIQ_API_URL",
            "VALIQ_AUTH_URL",
            "VALIQ_OAUTH_CLIENT_ID",
            "VALIQ_OAUTH_CLIENT_SECRET",
            "VALIQ_OAUTH_USER_UUID",
            "VALIQ_DATA_API_URL",
            "VALIQ_DATA_API_KEY",
        ]
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
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
        const tools: ToolDefinition[] = []

        const valiqUrl = config.secrets.VALIQ_API_URL
        const authUrl = config.secrets.VALIQ_AUTH_URL
        const clientId = config.secrets.VALIQ_OAUTH_CLIENT_ID
        const clientSecret = config.secrets.VALIQ_OAUTH_CLIENT_SECRET
        const userUuid = config.secrets.VALIQ_OAUTH_USER_UUID

        if (valiqUrl && authUrl && clientId && clientSecret && userUuid) {
            const tokenProvider = createOAuthTokenProvider({
                authUrl,
                clientId,
                clientSecret,
                userUuid,
                logger: config.runLogger,
            })

            const valiqClient = new ValiqClient({
                apiUrl: valiqUrl,
                tokenProvider,
                logger: config.runLogger,
            })
            const research = new ValiqResearchAdapter(valiqClient, config.runLogger)
            tools.push(createValiqResearchTool(research))
        }

        const dataApiUrl = config.secrets.VALIQ_DATA_API_URL
        const dataApiKey = config.secrets.VALIQ_DATA_API_KEY

        if (dataApiUrl && dataApiKey) {
            const dataClient = new ValiqDataClient({
                apiUrl: dataApiUrl,
                apiKey: dataApiKey,
                logger: config.runLogger,
            })
            const data = new ValiqDataAdapter(dataClient)
            tools.push(createValiqDataTool(data))
        }

        return tools
    }

    getEnvironment(): "paper" | "live" | undefined {
        return this.environment
    }

    private resolveCredentials(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): AlpacaCredentials {
        const apiKey = requireResolvedSecret(secrets, "ALPACA_PRIMARY_API_KEY", "ALPACA_API_KEY")
        const secretKey = requireResolvedSecret(secrets, "ALPACA_PRIMARY_SECRET_KEY", "ALPACA_SECRET_KEY")
        const accountId = secrets.ALPACA_ACCOUNT_ID ?? ""

        return {
            apiKey,
            secretKey,
            accountId,
            baseUrl: secrets.ALPACA_PRIMARY_BASE_URL ?? secrets.ALPACA_BASE_URL ?? undefined,
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
