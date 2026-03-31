import type { ToolDefinition } from "@valiq-trading/agent"
import { createValiqDataTool, createValiqResearchTool, ValiqClient, ValiqDataClient, ValiqDataAdapter, ValiqResearchAdapter, createOAuthTokenProvider } from "@valiq-trading/valiq"
import {
    getCurrentTimeInTimezone,
    mt5PolicySchema,
    padTime,
    requireResolvedSecret,
    type RiskValidator,
    type VenueAdapter,
} from "@valiq-trading/core"
import { MT5Client, type MT5WorkerCredentials, mt5RiskValidators, MT5VenueAdapter } from "@valiq-trading/mt5"
import type {
    VenuePlugin,
    ExtraToolsConfig,
    PreRunHookConfig,
    PreRunHookResult,
    PostRunHookConfig,
} from "../types"

export class MT5Plugin implements VenuePlugin {
    readonly app = "mt5"
    readonly venueName = "mt5"

    resolveSecretKeys(): string[] {
        return [
            "MT5_WORKER_URL",
            "MT5_WORKER_ACCESS_KEY",
            "MT5_PRIMARY_LOGIN",
            "MT5_PRIMARY_PASSWORD",
            "MT5_PRIMARY_SERVER",
            "MT5_LOGIN",
            "MT5_PASSWORD",
            "MT5_SERVER",
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
        const workerUrl = requireResolvedSecret(secrets, "MT5_WORKER_URL")
        const accessKey = requireResolvedSecret(secrets, "MT5_WORKER_ACCESS_KEY")
        const client = new MT5Client({ workerUrl, accessKey })

        await client.getHealth()

        const credentials = this.resolveValidationCredentials(secrets)
        if (credentials) {
            await client.connect(credentials)
        }
    }

    createVenueAdapter(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const resolved = this.resolveCredentials(policy, secrets)
        const client = new MT5Client({
            workerUrl: resolved.workerUrl,
            accessKey: resolved.accessKey,
        })
        return new MT5VenueAdapter(client, resolved.credentials)
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

    async preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult> {
        const mt5Venue = config.venue as MT5VenueAdapter

        const emergencyFlattened = await this.checkEmergencyFlatten(
            mt5Venue, config.policy, config.strategyId, config
        )
        if (emergencyFlattened) {
            return { skip: true, reason: "Emergency flatten executed" }
        }

        const eodFlattened = await this.checkEndOfDayFlatten(
            mt5Venue, config.policy, config.strategyId, config
        )
        if (eodFlattened) {
            return { skip: true, reason: "End-of-day flatten executed" }
        }

        return { skip: false }
    }

    async postRunHooks(config: PostRunHookConfig): Promise<void> {
        const mt5Venue = config.venue as MT5VenueAdapter
        await this.checkEmergencyFlatten(
            mt5Venue, config.policy, config.strategyId, config
        )
    }

    private async checkEmergencyFlatten(
        venue: MT5VenueAdapter,
        policy: Record<string, unknown>,
        strategyId: string,
        config: { logger: PreRunHookConfig["logger"]; createAlert: PreRunHookConfig["createAlert"] }
    ): Promise<boolean> {
        const parsedPolicy = mt5PolicySchema.parse(policy)
        const accountState = await venue.getAccountState()

        if (accountState.openPnl < 0 && Math.abs(accountState.openPnl) >= parsedPolicy.emergencyFlattenThreshold) {
            config.logger.error("Emergency flatten triggered", {
                strategyId,
                openPnl: accountState.openPnl,
                threshold: parsedPolicy.emergencyFlattenThreshold,
            })

            await config.createAlert({
                strategyId,
                app: this.app,
                severity: "critical",
                message: `Emergency flatten triggered: unrealized loss ${Math.abs(accountState.openPnl).toFixed(2)} exceeds threshold ${parsedPolicy.emergencyFlattenThreshold}`,
            })

            const result = await venue.closeAllPositions()
            config.logger.info("Emergency flatten completed", {
                closed: result.closed,
                results: result.results.map((r: { orderId: string; status: string }) => ({
                    orderId: r.orderId,
                    status: r.status,
                })),
            })

            return true
        }

        return false
    }

    private async checkEndOfDayFlatten(
        venue: MT5VenueAdapter,
        policy: Record<string, unknown>,
        strategyId: string,
        config: { logger: PreRunHookConfig["logger"]; createAlert: PreRunHookConfig["createAlert"] }
    ): Promise<boolean> {
        const parsedPolicy = mt5PolicySchema.parse(policy)
        const { end, timezone } = parsedPolicy.tradingHours

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

        config.logger.warn("End-of-day flatten triggered", {
            strategyId,
            currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
            endTime: end,
            openPositions: positions.length,
        })

        await config.createAlert({
            strategyId,
            app: this.app,
            severity: "warning",
            message: `End-of-day flatten: closing ${positions.length} position(s) before ${end} ${timezone}`,
        })

        const result = await venue.closeAllPositions()
        config.logger.info("End-of-day flatten completed", { closed: result.closed })

        return true
    }

    private resolveCredentials(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): { workerUrl: string; accessKey: string; credentials: MT5WorkerCredentials } {
        const workerUrl = requireResolvedSecret(secrets, "MT5_WORKER_URL")
        const login = requireResolvedSecret(secrets, "MT5_PRIMARY_LOGIN", "MT5_LOGIN")
        const password = requireResolvedSecret(secrets, "MT5_PRIMARY_PASSWORD", "MT5_PASSWORD")
        const server = requireResolvedSecret(secrets, "MT5_PRIMARY_SERVER", "MT5_SERVER")

        return {
            workerUrl,
            accessKey: requireResolvedSecret(secrets, "MT5_WORKER_ACCESS_KEY"),
            credentials: {
                login: Number(login),
                password,
                server,
            },
        }
    }

    private resolveValidationCredentials(
        secrets: Record<string, string | null>
    ): MT5WorkerCredentials | null {
        const login = secrets.MT5_PRIMARY_LOGIN ?? secrets.MT5_LOGIN
        const password = secrets.MT5_PRIMARY_PASSWORD ?? secrets.MT5_PASSWORD
        const server = secrets.MT5_PRIMARY_SERVER ?? secrets.MT5_SERVER

        if (login && password && server) {
            return {
                login: Number(login),
                password,
                server,
            }
        }

        for (const key of Object.keys(secrets)) {
            const match = key.match(/^MT5_(.+)_LOGIN$/)
            if (!match || match[1] === "PRIMARY") {
                continue
            }

            const prefix = match[1]
            const fallbackLogin = secrets[key]
            const fallbackPassword = secrets[`MT5_${prefix}_PASSWORD`]
            const fallbackServer = secrets[`MT5_${prefix}_SERVER`]

            if (fallbackLogin && fallbackPassword && fallbackServer) {
                return {
                    login: Number(fallbackLogin),
                    password: fallbackPassword,
                    server: fallbackServer,
                }
            }
        }

        return null
    }
}
