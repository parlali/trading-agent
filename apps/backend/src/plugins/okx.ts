import type { ToolDefinition } from "@valiq-trading/agent"
import {
    createOAuthTokenProvider,
    createValiqBreakingNewsTool,
    createValiqDataTool,
    createValiqResearchTool,
    getMissingValiqDataApiSecrets,
    resolveValiqDataApiConfig,
    ValiqClient,
    ValiqDataAdapter,
    ValiqDataClient,
    ValiqResearchAdapter,
} from "@valiq-trading/valiq"
import {
    ExecutionCostTracker,
    isWithinSessionFlatWindow,
    okxPolicySchema,
    type RiskValidator,
    type VenueAdapter,
} from "@valiq-trading/core"
import {
    createOKXMarketContextLine,
    createOKXSetupClassifierLine,
    OKXClient,
    OKX_RUNTIME_SECRET_KEYS,
    okxRiskValidators,
    OKXVenueAdapter,
    resolveOKXRuntimeConfig,
} from "@valiq-trading/okx"
import type {
    ExtraToolsConfig,
    PreRunHookConfig,
    PreRunHookResult,
    VenuePlugin,
} from "../types"

export class OKXPlugin implements VenuePlugin {
    readonly app = "okx-swap"
    readonly venueName = "okx"
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return [
            ...OKX_RUNTIME_SECRET_KEYS,
            "VALIQ_API_URL",
            "VALIQ_AUTH_URL",
            "VALIQ_OAUTH_CLIENT_ID",
            "VALIQ_OAUTH_CLIENT_SECRET",
            "VALIQ_OAUTH_USER_UUID",
            "VALIQ_DATA_API_URL",
            "VALIQ_DATA_API",
        ]
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const runtimeConfig = resolveOKXRuntimeConfig(secrets)
        const client = new OKXClient(runtimeConfig.credentials)

        await client.getPublicTime()

        const accountConfig = await client.getAccountConfig()
        if (accountConfig.acctLv === "1") {
            throw new Error("OKX account is in simple mode. Swap trading requires a derivatives-capable account mode.")
        }

        if (accountConfig.posMode !== runtimeConfig.positionMode) {
            throw new Error(
                `OKX account posMode ${accountConfig.posMode} does not match configured position mode ${runtimeConfig.positionMode}`
            )
        }

        await client.getBalance()
        await client.getPositions("SWAP")
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const runtimeConfig = resolveOKXRuntimeConfig(secrets)
        const client = new OKXClient(runtimeConfig.credentials)

        return new OKXVenueAdapter(client, {
            marginMode: runtimeConfig.marginMode,
            positionMode: runtimeConfig.positionMode,
        }, this.executionCostTracker)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return okxRiskValidators
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

        const dataApi = resolveValiqDataApiConfig(config.secrets)

        if (dataApi) {
            const dataClient = new ValiqDataClient({
                apiUrl: dataApi.apiUrl,
                apiKey: dataApi.apiKey,
                logger: config.runLogger,
            })
            const data = new ValiqDataAdapter(dataClient)
            tools.push(createValiqDataTool(data))
            tools.push(createValiqBreakingNewsTool(data))
        } else {
            const missing = getMissingValiqDataApiSecrets(config.secrets)
            if (missing.length > 0) {
                config.runLogger.warn(
                    "Valiq data tools NOT registered: missing secrets",
                    { missing }
                )
            }
        }

        return tools
    }

    async preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult> {
        const venue = config.venue as OKXVenueAdapter
        const policy = okxPolicySchema.parse(config.policy)

        const eodFlattened = await this.checkEndOfSessionFlatten(venue, policy, config.strategyId, config)
        if (eodFlattened) {
            return { skip: true, reason: "End-of-session flatten executed", providerStateChanged: true }
        }

        const runtimeContextLines = await this.buildRuntimeContextLines(venue, policy, config)
        return {
            skip: false,
            runtimeContextLines,
        }
    }

    private async checkEndOfSessionFlatten(
        _venue: OKXVenueAdapter,
        policy: ReturnType<typeof okxPolicySchema.parse>,
        strategyId: string,
        config: Pick<PreRunHookConfig, "logger" | "createAlert" | "ownedPositions" | "ownedWorkingOrders" | "sessionFlat">
    ): Promise<boolean> {
        const sessionFlatPolicy = policy.safety.sessionFlat
        if (!sessionFlatPolicy.enabled) {
            return false
        }

        const timezone = sessionFlatPolicy.timezone || policy.tradingHours.timezone
        const flattenWindow = isWithinSessionFlatWindow({
            end: policy.tradingHours.end,
            timezone,
            closeBufferMinutes: sessionFlatPolicy.closeBufferMinutes,
        })

        if (!flattenWindow.shouldFlatten) {
            return false
        }

        const positions = config.ownedPositions
        const workingOrders = config.ownedWorkingOrders
        if (positions.length === 0 && workingOrders.length === 0) {
            return false
        }

        config.logger.warn("OKX end-of-session flatten triggered", {
            strategyId,
            currentTime: flattenWindow.currentTime,
            endTime: policy.tradingHours.end,
            closeBufferMinutes: sessionFlatPolicy.closeBufferMinutes,
            openPositions: positions.length,
            workingOrders: workingOrders.length,
        })

        await config.createAlert({
            strategyId,
            app: this.app,
            severity: "warning",
            message: `Session-flat policy triggered: closing ${positions.length} position(s) and cancelling ${workingOrders.length} working order(s) before ${policy.tradingHours.end} ${timezone}`,
        })

        if (!config.sessionFlat) {
            throw new Error("Audited session-flat executor is unavailable for OKX")
        }

        const result = await config.sessionFlat.execute({
            positions,
            workingOrders,
            reason: `Session-flat before ${policy.tradingHours.end} ${timezone}`,
        })
        config.logger.info("OKX end-of-session flatten completed", {
            strategyId,
            closed: result.closed,
            cancelled: result.cancelled,
        })

        return true
    }

    private async buildRuntimeContextLines(
        venue: OKXVenueAdapter,
        policy: ReturnType<typeof okxPolicySchema.parse>,
        config: { logger: PreRunHookConfig["logger"]; strategyId: string }
    ): Promise<string[] | undefined> {
        try {
            const snapshots = await venue.getMarketSnapshot(policy.allowedInstruments)
            const contextLine = createOKXMarketContextLine(snapshots)
            const setupClassifierLine = createOKXSetupClassifierLine(snapshots, {
                fundingRateThreshold: policy.fundingRateThreshold,
            })

            if (!contextLine) {
                return undefined
            }

            config.logger.info("Collected OKX market context", {
                strategyId: config.strategyId,
                contextLine,
            })

            return setupClassifierLine
                ? [contextLine, setupClassifierLine]
                : [contextLine]
        } catch (error) {
            config.logger.warn("Failed to collect OKX market context", {
                strategyId: config.strategyId,
                error: error instanceof Error ? error.message : String(error),
            })

            return [
                "OKX market context unavailable for this run. Manage existing positions conservatively and avoid new entries unless risk-reward is exceptional.",
            ]
        }
    }
}
