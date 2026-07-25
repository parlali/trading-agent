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

const POLYMARKET_LOSS_EXIT_UNEVALUABLE_REASON_BAND_SIZE = 0.05
const POLYMARKET_LOSS_EXIT_MAX_SPREAD = POLYMARKET_LOSS_EXIT_UNEVALUABLE_REASON_BAND_SIZE
const POLYMARKET_LOSS_EXIT_MAX_TRIGGER_DISTANCE = POLYMARKET_LOSS_EXIT_UNEVALUABLE_REASON_BAND_SIZE
const POLYMARKET_LOSS_EXIT_PRICE_EPSILON = 1e-9

export class PolymarketPlugin implements VenuePlugin {
    readonly app = "polymarket"
    readonly venueName = "polymarket"
    private readonly executionCostTracker = new ExecutionCostTracker()
    private readonly lossCapUnevaluableAlertStateByStrategy = new Map<string, Map<string, PolymarketLossCapUnevaluableAlertState>>()

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
            this.lossCapUnevaluableAlertStateByStrategy.delete(config.strategyId)
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
            let lossCapUnevaluableAlertState = this.lossCapUnevaluableAlertStateByStrategy.get(config.strategyId)
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
                if (lossCapUnevaluableAlertState === undefined) {
                    lossCapUnevaluableAlertState = new Map()
                    this.lossCapUnevaluableAlertStateByStrategy.set(config.strategyId, lossCapUnevaluableAlertState)
                }

                const previousState = lossCapUnevaluableAlertState.get(item.position.instrument)
                if (previousState?.materialReasonKey !== item.evaluation.materialReasonKey) {
                    await config.createAlert({
                        strategyId: config.strategyId,
                        app: "polymarket",
                        severity: "warning",
                        message: `Polymarket loss cap unevaluable for ${label}: ${item.evaluation.reason}`,
                    })
                    lossCapUnevaluableAlertState.set(item.position.instrument, {
                        materialReasonKey: item.evaluation.materialReasonKey,
                    })
                }
                runtimeContextLines.push(
                    `LOSS CAP UNEVALUABLE: ${label} was not force-closed because ${item.evaluation.reason}.`
                )
            }

            for (const item of lossExitEvaluations) {
                if (item.evaluation.status === "unevaluable") {
                    continue
                }

                const previousState = lossCapUnevaluableAlertState?.get(item.position.instrument)
                if (previousState === undefined) {
                    continue
                }

                const label = formatPolymarketPositionLabel(item.position)
                await config.createAlert({
                    strategyId: config.strategyId,
                    app: "polymarket",
                    severity: "info",
                    message: `Polymarket loss cap evaluable again for ${label}`,
                })
                lossCapUnevaluableAlertState?.delete(item.position.instrument)
            }

            this.pruneLossCapUnevaluableAlertState(config.strategyId, positions)

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
        } else {
            this.lossCapUnevaluableAlertStateByStrategy.delete(config.strategyId)
        }

        return {
            skip: false,
            runtimeContextLines,
        }
    }

    private pruneLossCapUnevaluableAlertState(strategyId: string, positions: Position[]): void {
        const stateByInstrument = this.lossCapUnevaluableAlertStateByStrategy.get(strategyId)
        if (stateByInstrument === undefined) {
            return
        }

        const activeInstruments = new Set(positions.map((position) => position.instrument))
        for (const instrument of stateByInstrument.keys()) {
            if (!activeInstruments.has(instrument)) {
                stateByInstrument.delete(instrument)
            }
        }

        if (stateByInstrument.size === 0) {
            this.lossCapUnevaluableAlertStateByStrategy.delete(strategyId)
        }
    }
}

interface PolymarketPricedPosition {
    position: Position
    marketPrice: PolymarketMarketPrice
}

interface PolymarketLossCapUnevaluableAlertState {
    materialReasonKey: string
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
        materialReasonKey: string
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
            materialReasonKey: "unsupported-short-side",
        }
    }

    const bestBid = readExecutableProbability(marketPrice.bestBid)
    if (bestBid === undefined) {
        return {
            status: "unevaluable",
            reason: "book has no executable bid for the held token",
            materialReasonKey: "missing-held-token-bid",
        }
    }

    const bestAsk = readExecutableProbability(marketPrice.bestAsk)
    if (bestAsk === undefined) {
        return {
            status: "unevaluable",
            reason: "book has no executable ask to validate spread quality",
            materialReasonKey: "missing-held-token-ask",
        }
    }

    if (marketPrice.liquidityWarning === true) {
        return {
            status: "unevaluable",
            reason: "visible top-of-book does not satisfy minimum executable size",
            materialReasonKey: "insufficient-visible-size",
        }
    }

    const spread = readProbability(marketPrice.spread) ?? Math.max(bestAsk - bestBid, 0)
    if (spread > POLYMARKET_LOSS_EXIT_MAX_SPREAD) {
        return {
            status: "unevaluable",
            reason: `book spread ${spread.toFixed(4)} exceeds loss-cap evaluation limit ${POLYMARKET_LOSS_EXIT_MAX_SPREAD.toFixed(2)}`,
            materialReasonKey: `spread-band:${resolvePolymarketLossExitUnevaluableReasonBand(spread)}`,
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
            materialReasonKey: `trigger-distance-band:${lossExitPrice.toFixed(2)}:${resolvePolymarketLossExitUnevaluableReasonBand(triggerDistance)}`,
        }
    }

    return {
        status: midpoint <= lossExitPrice ? "breached" : "safe",
        evaluatedPrice: midpoint,
        executablePrice: bestBid,
    }
}

function resolvePolymarketLossExitUnevaluableReasonBand(value: number): number {
    return Math.floor((value + POLYMARKET_LOSS_EXIT_PRICE_EPSILON) / POLYMARKET_LOSS_EXIT_UNEVALUABLE_REASON_BAND_SIZE)
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
