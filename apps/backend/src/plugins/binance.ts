import type { ToolDefinition } from "@valiq-trading/agent"
import {
    createValiqBreakingNewsTool,
    createValiqDataTool,
    createValiqResearchTool,
    createOAuthTokenProvider,
    ValiqClient,
    ValiqDataAdapter,
    ValiqDataClient,
    ValiqResearchAdapter,
} from "@valiq-trading/valiq"
import {
    binancePolicySchema,
    getCurrentTimeInTimezone,
    padTime,
    requireResolvedSecret,
    type BinancePolicy,
    type RiskValidator,
    type VenueAdapter,
} from "@valiq-trading/core"
import {
    BinanceClient,
    BinanceVenueAdapter,
    binanceRiskValidators,
    createBinanceMarketContextLine,
    type BinanceCredentials,
} from "@valiq-trading/binance"
import type {
    VenuePlugin,
    ExtraToolsConfig,
    PostRunHookConfig,
    PreRunHookConfig,
    PreRunHookResult,
} from "../types"

export class BinancePlugin implements VenuePlugin {
    readonly app = "binance-futures"
    readonly venueName = "binance-futures"

    resolveSecretKeys(): string[] {
        return [
            "BINANCE_API_KEY",
            "BINANCE_API_SECRET",
            "BINANCE_BASE_URL",
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
        const credentials = this.resolveCredentials(secrets)
        const client = new BinanceClient(credentials)
        await client.ping()
        await client.getAccount()
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const credentials = this.resolveCredentials(secrets)
        const client = new BinanceClient(credentials)
        return new BinanceVenueAdapter(client)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return binanceRiskValidators
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
            tools.push(createValiqBreakingNewsTool(data))
        }

        return tools
    }

    async preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult> {
        const venue = config.venue as BinanceVenueAdapter
        const policy = binancePolicySchema.parse(config.policy)

        const emergencyFlattened = await this.checkEmergencyFlatten(venue, policy, config.strategyId, config)
        if (emergencyFlattened) {
            return { skip: true, reason: "Emergency flatten executed" }
        }

        const eodFlattened = await this.checkEndOfSessionFlatten(venue, policy, config.strategyId, config)
        if (eodFlattened) {
            return { skip: true, reason: "End-of-session flatten executed" }
        }

        const runtimeContextLines = await this.buildRuntimeContextLines(venue, policy, config)
        return {
            skip: false,
            runtimeContextLines,
        }
    }

    async postRunHooks(config: PostRunHookConfig): Promise<void> {
        const venue = config.venue as BinanceVenueAdapter
        const policy = binancePolicySchema.parse(config.policy)
        await this.checkEmergencyFlatten(venue, policy, config.strategyId, config)
    }

    private async checkEmergencyFlatten(
        venue: BinanceVenueAdapter,
        policy: BinancePolicy,
        strategyId: string,
        config: { logger: PreRunHookConfig["logger"]; createAlert: PreRunHookConfig["createAlert"] }
    ): Promise<boolean> {
        const accountState = await venue.getAccountState()

        if (accountState.openPnl < 0 && Math.abs(accountState.openPnl) >= policy.emergencyFlattenThreshold) {
            config.logger.error("Binance emergency flatten triggered", {
                strategyId,
                openPnl: accountState.openPnl,
                threshold: policy.emergencyFlattenThreshold,
            })

            await config.createAlert({
                strategyId,
                app: this.app,
                severity: "critical",
                message: `Binance emergency flatten triggered: unrealized loss ${Math.abs(accountState.openPnl).toFixed(2)} exceeds threshold ${policy.emergencyFlattenThreshold}`,
            })

            const result = await venue.closeAllPositions()
            config.logger.info("Binance emergency flatten completed", {
                strategyId,
                closed: result.closed,
            })

            return true
        }

        return false
    }

    private async checkEndOfSessionFlatten(
        venue: BinanceVenueAdapter,
        policy: BinancePolicy,
        strategyId: string,
        config: { logger: PreRunHookConfig["logger"]; createAlert: PreRunHookConfig["createAlert"] }
    ): Promise<boolean> {
        const { end, timezone } = policy.tradingHours
        const now = getCurrentTimeInTimezone(timezone)
        const [endHour, endMinute] = end.split(":").map(Number) as [number, number]

        const currentMinutes = now.hours * 60 + now.minutes
        const endMinutes = endHour * 60 + endMinute
        const flattenMinutes = endMinutes - 15
        const shouldFlatten = currentMinutes >= flattenMinutes && currentMinutes < endMinutes

        if (!shouldFlatten) {
            return false
        }

        const positions = await venue.getPositions()
        if (positions.length === 0) {
            return false
        }

        config.logger.warn("Binance end-of-session flatten triggered", {
            strategyId,
            currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
            endTime: end,
            openPositions: positions.length,
        })

        await config.createAlert({
            strategyId,
            app: this.app,
            severity: "warning",
            message: `Binance end-of-session flatten: closing ${positions.length} position(s) before ${end} ${timezone}`,
        })

        const result = await venue.closeAllPositions()
        config.logger.info("Binance end-of-session flatten completed", {
            strategyId,
            closed: result.closed,
        })

        return true
    }

    private async buildRuntimeContextLines(
        venue: BinanceVenueAdapter,
        policy: BinancePolicy,
        config: { logger: PreRunHookConfig["logger"]; strategyId: string }
    ): Promise<string[] | undefined> {
        try {
            const snapshots = await venue.getMarketSnapshot(policy.allowedInstruments)
            const contextLine = createBinanceMarketContextLine(snapshots)

            if (!contextLine) {
                return undefined
            }

            config.logger.info("Collected Binance market context", {
                strategyId: config.strategyId,
                contextLine,
            })

            return [contextLine]
        } catch (error) {
            config.logger.warn("Failed to collect Binance market context", {
                strategyId: config.strategyId,
                error: error instanceof Error ? error.message : String(error),
            })

            return [
                "Binance market context unavailable for this run. Manage existing positions conservatively and avoid new entries unless risk-reward is exceptional.",
            ]
        }
    }

    private resolveCredentials(
        secrets: Record<string, string | null>
    ): BinanceCredentials {
        return {
            apiKey: requireResolvedSecret(secrets, "BINANCE_API_KEY"),
            apiSecret: requireResolvedSecret(secrets, "BINANCE_API_SECRET"),
            baseUrl: secrets.BINANCE_BASE_URL ?? undefined,
        }
    }
}
