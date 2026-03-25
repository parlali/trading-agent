import type { ToolDefinition } from "@valiq-trading/agent"
import { createValiqDataTool, createValiqResearchTool, ValiqClient, ValiqDataAdapter, ValiqResearchAdapter } from "@valiq-trading/valiq"
import { mt5PolicySchema, type RiskValidator, type VenueAdapter } from "@valiq-trading/core"
import { MT5Client, type MT5WorkerCredentials } from "../../../mt5/src/mt5-client"
import { mt5RiskValidators } from "../../../mt5/src/risk-rules"
import { MT5VenueAdapter } from "../../../mt5/src/venue-adapter"
import type {
    VenuePlugin,
    ExtraToolsConfig,
    PreRunHookConfig,
    PreRunHookResult,
    PostRunHookConfig,
    VenueApp,
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
            "VALIQ_AUTH_TOKEN",
        ]
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const workerUrl = secrets.MT5_WORKER_URL
        if (!workerUrl) {
            throw new Error("MT5_WORKER_URL not found in resolved secrets")
        }

        const accessKey = secrets.MT5_WORKER_ACCESS_KEY ?? ""
        const client = new MT5Client({ workerUrl, accessKey })

        await client.getHealth()

        const login = secrets.MT5_PRIMARY_LOGIN ?? secrets.MT5_LOGIN
        const password = secrets.MT5_PRIMARY_PASSWORD ?? secrets.MT5_PASSWORD
        const server = secrets.MT5_PRIMARY_SERVER ?? secrets.MT5_SERVER

        if (login && password && server) {
            const credentials: MT5WorkerCredentials = {
                login: Number(login),
                password,
                server,
            }
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
                results: result.results.map((r) => ({
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
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): { workerUrl: string; accessKey: string; credentials: MT5WorkerCredentials } {
        const credentialsRef = String(policy.credentialsRef ?? "").trim()
        const prefix = credentialsRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

        const workerUrl = secrets.MT5_WORKER_URL
        if (!workerUrl) {
            throw new Error("MT5_WORKER_URL is required")
        }

        const login = secrets[`MT5_${prefix}_LOGIN`] ?? secrets.MT5_LOGIN
        const password = secrets[`MT5_${prefix}_PASSWORD`] ?? secrets.MT5_PASSWORD
        const server = secrets[`MT5_${prefix}_SERVER`] ?? secrets.MT5_SERVER

        if (!login) throw new Error(`Missing MT5 login for ${credentialsRef}`)
        if (!password) throw new Error(`Missing MT5 password for ${credentialsRef}`)
        if (!server) throw new Error(`Missing MT5 server for ${credentialsRef}`)

        return {
            workerUrl,
            accessKey: secrets.MT5_WORKER_ACCESS_KEY ?? "",
            credentials: {
                login: Number(login),
                password,
                server,
            },
        }
    }
}

function getCurrentTimeInTimezone(timezone: string): { hours: number; minutes: number } {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        })
        const parts = formatter.formatToParts(new Date())
        const hourPart = parts.find((p) => p.type === "hour")
        const minutePart = parts.find((p) => p.type === "minute")

        return {
            hours: Number(hourPart?.value ?? 0),
            minutes: Number(minutePart?.value ?? 0),
        }
    } catch {
        const now = new Date()
        return { hours: now.getUTCHours(), minutes: now.getUTCMinutes() }
    }
}

function padTime(n: number): string {
    return String(n).padStart(2, "0")
}
