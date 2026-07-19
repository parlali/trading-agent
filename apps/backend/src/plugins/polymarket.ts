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

const POLYMARKET_LOSS_EXIT_MAX_SPREAD = 0.05
const POLYMARKET_LOSS_EXIT_MAX_TRIGGER_DISTANCE = 0.05
const POLYMARKET_LOSS_EXIT_PRICE_EPSILON = 1e-9

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
            const lossExitEvaluations: PolymarketLossExitEvaluationItem[] = pricedPositions.map(({ position, marketPrice }) => ({
                position,
                marketPrice,
                evaluation: resolvePolymarketLossExitEvaluation(position, marketPrice, lossExitPrice),
            }))
            const unevaluable = lossExitEvaluations.filter(isUnevaluableLossExitEvaluation)
            for (const item of unevaluable) {
                const label = formatPolymarketPositionLabel(item.position)
                config.logger.warn("Polymarket loss cap book unevaluable; leaving position open", {
                    strategyId: config.strategyId,
                    instrument: item.position.instrument,
                    lossExitPrice,
                    reason: item.evaluation.reason,
                    bestBid: item.marketPrice.bestBid,
                    bestAsk: item.marketPrice.bestAsk,
                    spread: item.marketPrice.spread,
                    lastTradePrice: item.marketPrice.lastTradePrice,
                })
                await config.createAlert({
                    strategyId: config.strategyId,
                    app: "polymarket",
                    severity: "warning",
                    message: `Polymarket loss cap unevaluable for ${label}: ${item.evaluation.reason}`,
                })
                runtimeContextLines.push(
                    `LOSS CAP UNEVALUABLE: ${label} was not force-closed because ${item.evaluation.reason}.`
                )
            }

            const breached = lossExitEvaluations.filter(isBreachedLossExitEvaluation)

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
                    evaluatedPrices: breached.map(({ evaluation }) => evaluation.evaluatedPrice),
                    executablePrices: breached.map(({ evaluation }) => evaluation.executablePrice),
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

type PolymarketLossExitEvaluation =
    | {
        status: "safe"
        evaluatedPrice: number
        executablePrice: number
    }
    | {
        status: "breached"
        evaluatedPrice: number
        executablePrice: number
    }
    | {
        status: "unevaluable"
        reason: string
    }

interface PolymarketLossExitEvaluationItem {
    position: Position
    marketPrice: PolymarketMarketPrice
    evaluation: PolymarketLossExitEvaluation
}

function isUnevaluableLossExitEvaluation(
    item: PolymarketLossExitEvaluationItem
): item is PolymarketLossExitEvaluationItem & {
    evaluation: Extract<PolymarketLossExitEvaluation, { status: "unevaluable" }>
} {
    return item.evaluation.status === "unevaluable"
}

function isBreachedLossExitEvaluation(
    item: PolymarketLossExitEvaluationItem
): item is PolymarketLossExitEvaluationItem & {
    evaluation: Extract<PolymarketLossExitEvaluation, { status: "breached" }>
} {
    return item.evaluation.status === "breached"
}

function resolvePolymarketLossExitEvaluation(
    position: Position,
    marketPrice: PolymarketMarketPrice,
    lossExitPrice: number
): PolymarketLossExitEvaluation {
    if (position.side !== "long") {
        return {
            status: "unevaluable",
            reason: "short Polymarket loss-cap evaluation is unsupported for a long-token lossExitPrice policy",
        }
    }

    const bestBid = readExecutableProbability(marketPrice.bestBid)
    if (bestBid === undefined) {
        return {
            status: "unevaluable",
            reason: "book has no executable bid for the held token",
        }
    }

    const bestAsk = readExecutableProbability(marketPrice.bestAsk)
    if (bestAsk === undefined) {
        return {
            status: "unevaluable",
            reason: "book has no executable ask to validate spread quality",
        }
    }

    if (marketPrice.liquidityWarning === true) {
        return {
            status: "unevaluable",
            reason: "visible top-of-book does not satisfy minimum executable size",
        }
    }

    const spread = readProbability(marketPrice.spread) ?? Math.max(bestAsk - bestBid, 0)
    if (spread > POLYMARKET_LOSS_EXIT_MAX_SPREAD) {
        return {
            status: "unevaluable",
            reason: `book spread ${spread.toFixed(4)} exceeds loss-cap evaluation limit ${POLYMARKET_LOSS_EXIT_MAX_SPREAD.toFixed(2)}`,
        }
    }

    const midpoint = readExecutableProbability(marketPrice.midpoint) ?? (bestBid + bestAsk) / 2
    const triggerDistance = Math.abs(lossExitPrice - bestBid)
    if (
        midpoint <= lossExitPrice &&
        triggerDistance > POLYMARKET_LOSS_EXIT_MAX_TRIGGER_DISTANCE + POLYMARKET_LOSS_EXIT_PRICE_EPSILON
    ) {
        return {
            status: "unevaluable",
            reason: `loss cap ${lossExitPrice.toFixed(2)} is not executable within ${POLYMARKET_LOSS_EXIT_MAX_TRIGGER_DISTANCE.toFixed(2)} of best bid ${bestBid.toFixed(4)}`,
        }
    }

    return {
        status: midpoint <= lossExitPrice ? "breached" : "safe",
        evaluatedPrice: midpoint,
        executablePrice: bestBid,
    }
}

function readExecutableProbability(value: unknown): number | undefined {
    const probability = readProbability(value)
    return probability !== undefined && probability > 0 && probability < 1
        ? probability
        : undefined
}

function readProbability(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : undefined
}
