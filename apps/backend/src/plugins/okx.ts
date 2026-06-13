import {
    ExecutionCostTracker,
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
import {
    appendMcpSecretKeys,
    createMcpTools,
    executeSessionFlatIfNeeded,
} from "./shared"

export class OKXPlugin implements VenuePlugin {
    readonly app = "okx-swap"
    readonly venueName = "okx"
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return appendMcpSecretKeys(OKX_RUNTIME_SECRET_KEYS)
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

    async getExtraTools(config: ExtraToolsConfig) {
        return await createMcpTools(config)
    }

    async preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult> {
        const venue = config.venue as OKXVenueAdapter
        const policy = okxPolicySchema.parse(config.policy)

        const eodFlattened = await this.checkEndOfSessionFlatten(policy, config.strategyId, config)
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
        policy: ReturnType<typeof okxPolicySchema.parse>,
        strategyId: string,
        config: Pick<PreRunHookConfig, "logger" | "createAlert" | "ownedPositions" | "ownedWorkingOrders" | "sessionFlat">
    ): Promise<boolean> {
        return await executeSessionFlatIfNeeded({
            app: this.app,
            strategyId,
            policy,
            config,
            unavailableMessage: "Audited session-flat executor is unavailable for OKX",
            triggeredLogMessage: "OKX end-of-session flatten triggered",
            completedLogMessage: "OKX end-of-session flatten completed",
        })
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
