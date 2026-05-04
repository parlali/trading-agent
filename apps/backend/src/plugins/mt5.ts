import {
    ExecutionCostTracker,
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
import {
    appendValiqSecretKeys,
    createValiqTools,
    executeSessionFlatIfNeeded,
} from "./shared"

export class MT5Plugin implements VenuePlugin {
    readonly app = "mt5"
    readonly venueName = "mt5"
    private readonly holidayGuard = new HolidayGuard()
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return appendValiqSecretKeys(MT5_RUNTIME_SECRET_KEYS)
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const runtimeConfig = resolveMT5RuntimeConfig(secrets)
        const healthClient = new MT5Client({
            workerUrl: runtimeConfig.workerUrl,
            accessKey: runtimeConfig.accessKey,
            timeout: 2_000,
        })
        await healthClient.getHealth()

        const client = new MT5Client({
            workerUrl: runtimeConfig.workerUrl,
            accessKey: runtimeConfig.accessKey,
        })
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

    getExtraTools(config: ExtraToolsConfig) {
        return createValiqTools(config, {
            research: true,
            data: true,
        })
    }

    async preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult> {
        const mt5Venue = config.venue as MT5VenueAdapter
        const parsedPolicy = mt5PolicySchema.parse(config.policy)

        const eodFlattened = await this.checkEndOfDayFlatten(parsedPolicy, config.strategyId, config)
        if (eodFlattened) {
            return { skip: true, reason: "End-of-day flatten executed", providerStateChanged: true }
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
        policy: ReturnType<typeof mt5PolicySchema.parse>,
        strategyId: string,
        config: Pick<PreRunHookConfig, "logger" | "createAlert" | "ownedPositions" | "ownedWorkingOrders" | "sessionFlat">
    ): Promise<boolean> {
        return await executeSessionFlatIfNeeded({
            app: this.app,
            strategyId,
            policy,
            config,
            unavailableMessage: "Audited session-flat executor is unavailable for MT5",
            triggeredLogMessage: "End-of-day flatten triggered",
            completedLogMessage: "End-of-day flatten completed",
        })
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
