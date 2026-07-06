import {
    BASE_RISK_VALIDATORS,
    ExecutionCostTracker,
    type Position,
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
        const positions = config.ownedPositions
        if (positions.length === 0) {
            return { skip: false }
        }

        let pricedPositions: PolymarketPricedPosition[]

        try {
            pricedPositions = await Promise.all(
                positions.map(async (position) => {
                    const marketPrice = await venue.getMarketPrice(position.instrument)
                    return { position, marketPrice }
                })
            )

            config.logger.info("Collected Polymarket execution-cost context", {
                strategyId: config.strategyId,
                positionCount: positions.length,
            })
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

        const runtimeContextLines = buildPolymarketRuntimeContextLines(pricedPositions)
        const lossExitPrice = readPolymarketLossExitPrice(config.policy)

        if (lossExitPrice !== undefined) {
            const breached = pricedPositions.filter(({ marketPrice }) => {
                const livePrice = resolvePolymarketLossExitLivePrice(marketPrice)
                return livePrice !== undefined && livePrice <= lossExitPrice
            })

            if (breached.length > 0) {
                if (!config.sessionFlat) {
                    throw new Error("Polymarket loss-cap exit required but audited session-flat executor is unavailable")
                }

                const breachedPositions = breached.map(({ position }) => position)
                const closedLabels = breachedPositions.map(formatPolymarketPositionLabel)
                const reason = `Loss cap ${lossExitPrice.toFixed(2)} breached`

                config.logger.warn("Polymarket loss cap breached; force-closing positions", {
                    strategyId: config.strategyId,
                    lossExitPrice,
                    positionCount: breachedPositions.length,
                    instruments: breachedPositions.map((position) => position.instrument),
                })

                await config.sessionFlat.execute({
                    positions: breachedPositions,
                    workingOrders: [],
                    reason,
                })

                await config.createAlert({
                    strategyId: config.strategyId,
                    app: "polymarket",
                    severity: "warning",
                    message: `Polymarket loss cap ${lossExitPrice.toFixed(2)} breached; force-closed ${breachedPositions.length} position(s): ${closedLabels.join("; ")}`,
                })

                runtimeContextLines.push(
                    `LOSS CAP ENFORCED: ${closedLabels.join("; ")} were force-closed because live price was at or below ${lossExitPrice.toFixed(2)}. Do not reopen those markets this run.`
                )

                return {
                    skip: false,
                    providerStateChanged: true,
                    runtimeContextLines,
                }
            }
        }

        return {
            skip: false,
            runtimeContextLines,
        }
    }
}

interface PolymarketPricedPosition {
    position: Position
    marketPrice: PolymarketMarketPrice
}

function buildPolymarketRuntimeContextLines(pricedPositions: PolymarketPricedPosition[]): string[] {
    const lines = pricedPositions.map(({ position, marketPrice }) =>
        formatPolymarketExecutionContextLine(position, marketPrice)
    )
    const positions = pricedPositions.map(({ position }) => position)
    const runtimeContextLines = [
        `Current Polymarket execution context: ${lines.join(" | ")}`,
    ]
    const pastEndDate = positions.filter((position) => {
        const endDateIso = position.metadata?.endDateIso
        return typeof endDateIso === "string" && Date.parse(endDateIso) < Date.now()
    })
    if (pastEndDate.length > 0) {
        const labels = pastEndDate.map(formatPolymarketPositionLabel)
        runtimeContextLines.push(
            `SETTLEMENT REQUIRED: ${pastEndDate.length} held market(s) are past their end date and have likely resolved: ${labels.join("; ")}. Verify resolution and close each position this run; resolved closes settle at the final outcome price.`
        )
    }

    return runtimeContextLines
}

function readPolymarketLossExitPrice(policy: Record<string, unknown>): number | undefined {
    const value = policy.lossExitPrice
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
        ? value
        : undefined
}

function resolvePolymarketLossExitLivePrice(marketPrice: PolymarketMarketPrice): number | undefined {
    return marketPrice.executionCost.metrics.midpoint ?? marketPrice.midpoint ?? marketPrice.executablePrice
}

function formatPolymarketExecutionContextLine(
    position: Position,
    marketPrice: PolymarketMarketPrice
): string {
    return `${formatPolymarketPositionLabel(position)} ${marketPrice.executionCost.summary}`
}

function formatPolymarketPositionLabel(position: Position): string {
    const question = typeof position.metadata?.question === "string"
        ? position.metadata.question
        : position.instrument
    const outcome = typeof position.metadata?.outcome === "string"
        ? position.metadata.outcome
        : "position"

    return `${question} [${outcome}]`
}
