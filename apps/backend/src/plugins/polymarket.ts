import type { ToolDefinition } from "@valiq-trading/agent"
import {
    ExecutionCostTracker,
    type RiskValidator,
    type VenueAdapter,
} from "@valiq-trading/core"
import {
    PolymarketClient,
    polymarketRiskValidators,
    POLYMARKET_RUNTIME_SECRET_KEYS,
    type PolymarketMarketPrice,
    PolymarketVenueAdapter,
    resolvePolymarketCredentials,
} from "@valiq-trading/polymarket"
import {
    createValiqBreakingNewsTool,
    VALIQ_DATA_SECRET_KEYS,
    getMissingValiqDataApiSecrets,
    resolveValiqDataApiConfig,
    ValiqDataClient,
    ValiqDataAdapter,
} from "@valiq-trading/valiq"
import type {
    VenuePlugin,
    ExtraToolsConfig,
    PreRunHookConfig,
    PreRunHookResult,
} from "../types"

export class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket"
    readonly venueName = "polymarket"
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return [
            ...POLYMARKET_RUNTIME_SECRET_KEYS,
            ...VALIQ_DATA_SECRET_KEYS,
        ]
    }

    resolveAdditionalSecretKeys(_policy: Record<string, unknown>): string[] {
        return []
    }

    async validateEnvironment(secrets: Record<string, string | null>): Promise<void> {
        const credentials = resolvePolymarketCredentials(secrets)
        const client = new PolymarketClient(credentials)
        await client.getBalance()
        await client.getOpenOrders()
    }

    createVenueAdapter(
        _policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter {
        const credentials = resolvePolymarketCredentials(secrets)
        const client = new PolymarketClient(credentials)
        return new PolymarketVenueAdapter(client, this.executionCostTracker)
    }

    getRiskValidators(): readonly RiskValidator[] {
        return polymarketRiskValidators
    }

    getExtraTools(config: ExtraToolsConfig): ToolDefinition[] {
        const dataApi = resolveValiqDataApiConfig(config.secrets)

        if (!dataApi) {
            const missing = getMissingValiqDataApiSecrets(config.secrets)
            config.runLogger.warn(
                "Valiq tools NOT registered: missing secrets",
                { missing }
            )
            return []
        }

        const dataClient = new ValiqDataClient({
            apiUrl: dataApi.apiUrl,
            apiKey: dataApi.apiKey,
            logger: config.runLogger,
        })
        const data = new ValiqDataAdapter(dataClient)

        return [
            createValiqBreakingNewsTool(data),
        ]
    }

    async preRunHooks(config: PreRunHookConfig): Promise<PreRunHookResult> {
        const venue = config.venue as PolymarketVenueAdapter

        try {
            const positions = config.ownedPositions
            if (positions.length === 0) {
                return { skip: false }
            }

            const lines = await Promise.all(
                positions.map(async (position) => {
                    const marketPrice = await venue.getMarketPrice(position.instrument)
                    return formatPolymarketExecutionContextLine(position, marketPrice)
                })
            )

            config.logger.info("Collected Polymarket execution-cost context", {
                strategyId: config.strategyId,
                positionCount: positions.length,
            })

            return {
                skip: false,
                runtimeContextLines: [
                    `Current Polymarket execution context: ${lines.join(" | ")}`,
                ],
            }
        } catch (error) {
            config.logger.warn("Failed to collect Polymarket execution-cost context", {
                strategyId: config.strategyId,
                error: error instanceof Error ? error.message : String(error),
            })

            return {
                skip: false,
                runtimeContextLines: [
                    "Polymarket execution-cost context unavailable for this run. Refresh live venue pricing before changing any open position.",
                ],
            }
        }
    }
}

function formatPolymarketExecutionContextLine(
    position: Awaited<ReturnType<PolymarketVenueAdapter["getPositions"]>>[number],
    marketPrice: PolymarketMarketPrice
): string {
    const question = typeof position.metadata?.question === "string"
        ? position.metadata.question
        : position.instrument
    const outcome = typeof position.metadata?.outcome === "string"
        ? position.metadata.outcome
        : "position"

    return `${question} [${outcome}] ${marketPrice.executionCost.summary}`
}
