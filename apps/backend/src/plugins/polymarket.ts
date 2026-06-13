import {
    BASE_RISK_VALIDATORS,
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
import type {
    VenuePlugin,
    ExtraToolsConfig,
    PreRunHookConfig,
    PreRunHookResult,
} from "../types"
import {
    appendMcpSecretKeys,
    createMcpTools,
} from "./shared"

export class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket"
    readonly venueName = "polymarket"
    private readonly executionCostTracker = new ExecutionCostTracker()

    resolveSecretKeys(): string[] {
        return appendMcpSecretKeys(POLYMARKET_RUNTIME_SECRET_KEYS)
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
        return [...BASE_RISK_VALIDATORS, ...polymarketRiskValidators]
    }

    async getExtraTools(config: ExtraToolsConfig) {
        return await createMcpTools(config)
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
