import type { ToolDefinition } from "@valiq-trading/agent"
import {
    createOAuthTokenProvider,
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
    mt5PolicySchema,
    type RiskValidator,
    type VenueAdapter,
} from "@valiq-trading/core"
import {
    createMT5SpreadContextLine,
    HolidayGuard,
    MT5Client,
    MT5_RUNTIME_SECRET_KEYS,
    mt5RiskValidators,
    resolveMT5RuntimeConfig,
    MT5VenueAdapter,
    resolveMT5InstrumentRegions,
} from "@valiq-trading/mt5"
import type {
    VenuePlugin,
    ExtraToolsConfig,
    PreRunHookConfig,
    PreRunHookResult,
} from "../types"

export class MT5Plugin implements VenuePlugin {
    readonly app = "mt5"
    readonly venueName = "mt5"
    private readonly holidayGuard = new HolidayGuard()
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return [
            ...MT5_RUNTIME_SECRET_KEYS,
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
        const runtimeConfig = resolveMT5RuntimeConfig(secrets)
        const client = new MT5Client({
            workerUrl: runtimeConfig.workerUrl,
            accessKey: runtimeConfig.accessKey,
        })

        await client.getHealth()
        await client.connect(runtimeConfig.credentials)
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const resolved = resolveMT5RuntimeConfig(secrets)
        const client = new MT5Client({
            workerUrl: resolved.workerUrl,
            accessKey: resolved.accessKey,
        })
        return new MT5VenueAdapter(client, resolved.credentials, this.executionCostTracker)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return mt5RiskValidators
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
        const mt5Venue = config.venue as MT5VenueAdapter
        const parsedPolicy = mt5PolicySchema.parse(config.policy)

        const eodFlattened = await this.checkEndOfDayFlatten(
            mt5Venue, parsedPolicy, config.strategyId, config
        )
        if (eodFlattened) {
            return { skip: true, reason: "End-of-day flatten executed" }
        }

        const instrumentRegions = resolveMT5InstrumentRegions(parsedPolicy)
        try {
            const holidayCheck = this.holidayGuard.checkInstrumentRegions(instrumentRegions)
            if (holidayCheck.isHoliday) {
                config.logger.warn("Market holiday guard skipped MT5 run", {
                    strategyId: config.strategyId,
                    reason: holidayCheck.reason,
                    instrumentRegions,
                })

                return {
                    skip: true,
                    reason: `Market holiday: ${holidayCheck.reason}`,
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            config.logger.warn("Holiday guard failed for MT5 run", {
                strategyId: config.strategyId,
                instrumentRegions,
                error: message,
            })

            return {
                skip: true,
                reason: `Holiday guard failed: ${message}`,
            }
        }

        const runtimeContextLines = await this.buildRuntimeContextLines(
            mt5Venue,
            instrumentRegions,
            config
        )

        return { skip: false, runtimeContextLines }
    }

    private async checkEndOfDayFlatten(
        venue: MT5VenueAdapter,
        policy: ReturnType<typeof mt5PolicySchema.parse>,
        strategyId: string,
        config: { logger: PreRunHookConfig["logger"]; createAlert: PreRunHookConfig["createAlert"] }
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

        const positions = await venue.getPositions()
        if (positions.length === 0) {
            return false
        }

        config.logger.warn("End-of-day flatten triggered", {
            strategyId,
            currentTime: flattenWindow.currentTime,
            endTime: policy.tradingHours.end,
            closeBufferMinutes: sessionFlatPolicy.closeBufferMinutes,
            openPositions: positions.length,
        })

        await config.createAlert({
            strategyId,
            app: this.app,
            severity: "warning",
            message: `Session-flat policy triggered: closing ${positions.length} position(s) before ${policy.tradingHours.end} ${timezone}`,
        })

        const result = await venue.closeAllPositions()
        config.logger.info("End-of-day flatten completed", { closed: result.closed })

        return true
    }

    private async buildRuntimeContextLines(
        venue: MT5VenueAdapter,
        instrumentRegions: Record<string, string[]>,
        config: { logger: PreRunHookConfig["logger"]; strategyId: string }
    ): Promise<string[] | undefined> {
        const instruments = Object.keys(instrumentRegions)
        if (instruments.length === 0) {
            return undefined
        }

        try {
            const snapshots = await venue.getMarketSnapshot(instruments)
            const received = new Set(snapshots.map((snapshot) => snapshot.instrument))
            const missing = instruments.filter((instrument) => !received.has(instrument))

            if (missing.length > 0) {
                config.logger.warn("MT5 execution-cost data is incomplete for this run", {
                    strategyId: config.strategyId,
                    requested: instruments,
                    received: [...received],
                    missing,
                })

                return [
                    `MT5 execution-cost context unavailable for: ${missing.join(", ")}. Sit out on new entries unless a later run provides complete venue pricing context.`,
                ]
            }

            const executionCostContextLine = createMT5SpreadContextLine(snapshots)
            if (!executionCostContextLine) {
                return undefined
            }

            config.logger.info("Collected MT5 execution-cost context", {
                strategyId: config.strategyId,
                executionCostContextLine,
            })

            return [executionCostContextLine]
        } catch (error) {
            config.logger.warn("Failed to collect MT5 execution-cost context", {
                strategyId: config.strategyId,
                error: error instanceof Error ? error.message : String(error),
            })

            return [
                "MT5 execution-cost context unavailable for this run. Trade only if an open position requires active management.",
            ]
        }
    }

}
