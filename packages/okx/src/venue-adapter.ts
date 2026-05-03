import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    type AccountState,
    type ExecutionCostAssessment,
    type ExecutionCostSnapshot,
    type ExecutionResult,
    type OrderIntent,
    type PriceVerification,
    type PriceVerifier,
    type Position,
    type ProviderPositionClosure,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import {
    OKXClient,
    type OKXAccountBalance,
    type OKXAttachedAlgoOrderParams,
    type OKXAlgoOrder,
    type OKXApiPosSide,
    type OKXFill,
    type OKXInstrument,
    type OKXMarginMode,
    type OKXOrder,
    type OKXOrderBookLevel,
    type OKXOrderType,
    type OKXPosition,
    type OKXPositionMode,
} from "./okx-client"
import type { OKXMarketSnapshot } from "./market-context"

export interface OKXInstrumentRules {
    instId: string
    baseCcy?: string
    quoteCcy?: string
    settleCcy?: string
    tickSize: number
    lotSize: number
    minContracts: number
    contractValue: number
    contractValueCurrency?: string
    instType: string
    state: string
}

interface CompositeOrderId {
    kind: "order" | "algo"
    instId: string
    rawId: string
}

interface NormalizedOrderSize {
    contracts: number
    baseQuantity: number
}

interface ProtectionLevelMap {
    stopLoss?: number
    takeProfit?: number
}

export interface OKXMarketPrice {
    symbol: string
    markPrice: number
    lastPrice: number
    bestBid: number
    bestAsk: number
    spread: number
    fundingRate?: number
    nextFundingTime?: number
    executionCost: ExecutionCostAssessment
}

export class OKXVenueAdapter implements VenueAdapter, PriceVerifier {
    private readonly instrumentRulesCache = new Map<string, OKXInstrumentRules>()
    private accountConfigValidated = false

    constructor(
        private readonly client: OKXClient,
        private readonly config: {
            marginMode: OKXMarginMode
            positionMode: OKXPositionMode
        },
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

    async getPositions(): Promise<Position[]> {
        const [positions, algoOrders] = await Promise.all([
            this.client.getPositions("SWAP"),
            this.client.getAlgoOrdersPending("SWAP"),
        ])

        const protectionByInstrument = new Map<string, ProtectionLevelMap>()

        for (const order of algoOrders) {
            const key = this.getProtectionKey(order.instId, order.posSide)
            const current = protectionByInstrument.get(key) ?? {}

            if (isFiniteNumberString(order.slTriggerPx) && current.stopLoss === undefined) {
                current.stopLoss = Number(order.slTriggerPx)
            }

            if (isFiniteNumberString(order.tpTriggerPx) && current.takeProfit === undefined) {
                current.takeProfit = Number(order.tpTriggerPx)
            }

            protectionByInstrument.set(key, current)
        }

        const normalized: Array<Position | null> = await Promise.all(
            positions.map(async (position) => {
                const contracts = Math.abs(Number(position.pos))
                if (!Number.isFinite(contracts) || contracts <= 0) {
                    return null
                }

                const rules = await this.getInstrumentRules(position.instId)
                const side = resolvePositionSide(position, this.config.positionMode)
                const quantity = this.contractsToBaseQuantity(rules, contracts)
                const protectionKey = this.getProtectionKey(
                    position.instId,
                    this.resolvePositionPosSide(side)
                )
                const protection = protectionByInstrument.get(protectionKey)

                return {
                    instrument: position.instId,
                    providerPositionId: position.posId,
                    side,
                    quantity,
                    entryPrice: Number(position.avgPx),
                    currentPrice: Number(position.markPx),
                    unrealizedPnl: Number(position.upl),
                    stopLoss: protection?.stopLoss,
                    takeProfit: protection?.takeProfit,
                    metadata: {
                        contracts,
                        contractValue: rules.contractValue,
                        contractValueCurrency: rules.contractValueCurrency,
                        marginMode: position.mgnMode,
                        leverage: position.lever ? Number(position.lever) : undefined,
                        liquidationPrice: isFiniteNumberString(position.liqPx) ? Number(position.liqPx) : undefined,
                        positionMode: this.config.positionMode,
                        posId: position.posId,
                    },
                } satisfies Position
            })
        )

        return normalized.filter((position): position is Position => position !== null)
    }

    async getAccountState(): Promise<AccountState> {
        const [balance, positions] = await Promise.all([
            this.client.getBalance(),
            this.client.getPositions("SWAP"),
        ])
        return await this.mapAccountState(balance, positions)
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const [orders, algoOrders, positions] = await Promise.all([
            this.client.getOrdersPending("SWAP"),
            this.client.getAlgoOrdersPending("SWAP"),
            this.getPositions(),
        ])

        const quantityByInstrument = new Map(
            positions.map((position) => [this.getProtectionKey(position.instrument, this.resolvePositionPosSide(position.side)), position.quantity])
        )

        const standardOrders = await Promise.all(
            orders.map(async (order) => {
                const rules = await this.getInstrumentRules(order.instId)
                const quantity = this.contractsToBaseQuantity(rules, Number(order.sz))
                const filledQuantity = this.contractsToBaseQuantity(rules, Number(order.accFillSz))
                const submittedAt = parseUnixMs(order.cTime)
                const updatedAt = parseUnixMs(order.uTime) ?? submittedAt ?? Date.now()

                return {
                    orderId: toCompositeOrderId("order", order.instId, order.ordId),
                    instrument: order.instId,
                    status: mapOKXOrderStatus(order.state),
                    quantity,
                    filledQuantity,
                    remainingQuantity: Math.max(quantity - filledQuantity, 0),
                    submittedAt: submittedAt ?? updatedAt,
                    updatedAt,
                    side: order.side,
                    limitPrice: isFiniteNumberString(order.px) && Number(order.px) > 0 ? Number(order.px) : undefined,
                    avgFillPrice: isFiniteNumberString(order.avgPx) && Number(order.avgPx) > 0 ? Number(order.avgPx) : undefined,
                    metadata: {
                        orderType: order.ordType,
                        reduceOnly: order.reduceOnly === "true",
                        tdMode: order.tdMode,
                        posSide: order.posSide,
                    },
                } satisfies WorkingOrder
            })
        )

        const protectionOrders = algoOrders.map((order) => {
            const quantity = quantityByInstrument.get(
                this.getProtectionKey(order.instId, order.posSide)
            ) ?? 0
            const submittedAt = parseUnixMs(order.cTime) ?? Date.now()
            const updatedAt = parseUnixMs(order.uTime) ?? submittedAt

            return {
                orderId: toCompositeOrderId("algo", order.instId, order.algoId),
                instrument: order.instId,
                status: mapOKXAlgoOrderStatus(order.state),
                quantity,
                filledQuantity: 0,
                remainingQuantity: quantity,
                submittedAt,
                updatedAt,
                side: order.side,
                stopPrice: isFiniteNumberString(order.slTriggerPx) ? Number(order.slTriggerPx) : undefined,
                limitPrice: isFiniteNumberString(order.tpTriggerPx) ? Number(order.tpTriggerPx) : undefined,
                metadata: {
                    orderType: order.ordType,
                    kind: "protection",
                    posSide: order.posSide,
                    tpTriggerPx: order.tpTriggerPx,
                    slTriggerPx: order.slTriggerPx,
                },
            } satisfies WorkingOrder
        })

        return [...standardOrders, ...protectionOrders]
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        const instId = normalizeInstrument(intent.instrument)

        if (intent.orderType !== "market" && intent.orderType !== "limit") {
            throw createExecutionError(
                "pre_validation",
                `OKX swap supports market and limit execution orders in this runtime path. Received ${intent.orderType}.`,
                {
                    code: "UNSUPPORTED_ORDER_TYPE",
                    retryable: false,
                    details: {
                        instId,
                        orderType: intent.orderType,
                    },
                }
            )
        }

        const rules = await this.getInstrumentRules(instId)
        await this.assertTradingPreconditions()

        const leverage = resolveLeverage(intent)
        if (!isCloseAction(intent) && leverage !== undefined) {
            await this.client.setLeverage({
                instId,
                lever: String(leverage),
                mgnMode: this.config.marginMode,
                posSide: this.resolveLeveragePosSide(intent.side),
            })
        }

        const markPrice = await this.getCurrentMarkPrice(instId)
        const notionalPrice = intent.limitPrice ?? markPrice
        const sizing = await this.normalizeQuantity(instId, intent.quantity)

        if (sizing.baseQuantity <= 0 || sizing.contracts <= 0) {
            throw createExecutionError(
                "pre_validation",
                `Order quantity for ${instId} is below OKX minimum contract size`,
                {
                    code: "QUANTITY_BELOW_MINIMUM",
                    retryable: false,
                    details: {
                        instId,
                        requestedQuantity: intent.quantity,
                    },
                }
            )
        }

        if (notionalPrice <= 0) {
            throw createExecutionError(
                "pre_validation",
                `Resolved notional price for ${instId} is invalid`,
                {
                    code: "INVALID_PRICE",
                    retryable: false,
                    details: {
                        instId,
                        markPrice,
                        limitPrice: intent.limitPrice,
                    },
                }
            )
        }

        const px = intent.limitPrice !== undefined
            ? await this.normalizePrice(instId, intent.limitPrice)
            : undefined
        const attachAlgoOrds = await this.buildAttachedProtectionOrders(instId, intent)
        const ack = await this.client.placeOrder({
            instId,
            tdMode: this.config.marginMode,
            side: intent.side,
            ordType: mapToOKXOrderType(intent.orderType, intent.timeInForce),
            sz: formatContracts(sizing.contracts),
            px: px !== undefined ? formatNumber(px) : undefined,
            posSide: this.resolveEntryPosSide(intent.side),
            reduceOnly: isCloseAction(intent),
            attachAlgoOrds,
        })

        const order = await this.client.getOrder(instId, ack.ordId)
        return await this.mapExecutionResult(instId, order)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        const parsed = parseCompositeOrderId(orderId)
        if (!parsed) {
            throw createExecutionError("pre_validation", `Unsupported OKX order id format: ${orderId}`, {
                code: "INVALID_ORDER_ID",
                retryable: false,
                details: {
                    orderId,
                },
            })
        }

        if (parsed.kind === "algo") {
            await this.client.cancelAlgoOrders([
                {
                    algoId: parsed.rawId,
                    instId: parsed.instId,
                },
            ])

            return {
                orderId,
                status: "cancelled",
                filledQuantity: 0,
                timestamp: Date.now(),
            }
        }

        await this.client.cancelOrder(parsed.instId, parsed.rawId)
        const order = await this.client.getOrder(parsed.instId, parsed.rawId)
        return await this.mapExecutionResult(parsed.instId, order)
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        const parsed = parseCompositeOrderId(orderId)
        if (!parsed || parsed.kind !== "order") {
            throw createExecutionError("pre_validation", `Unsupported OKX order id format: ${orderId}`, {
                code: "INVALID_ORDER_ID",
                retryable: false,
                details: {
                    orderId,
                },
            })
        }

        if (changes.stopPrice !== undefined) {
            throw createExecutionError("pre_validation", "OKX swap order amendments do not support changing stopPrice on live regular orders", {
                code: "UNSUPPORTED_MODIFICATION",
                retryable: false,
                details: {
                    orderId,
                    stopPrice: changes.stopPrice,
                },
            })
        }

        const rules = await this.getInstrumentRules(parsed.instId)
        const newPx = changes.limitPrice !== undefined
            ? formatNumber(await this.normalizePrice(parsed.instId, changes.limitPrice))
            : undefined
        const newSz = changes.quantity !== undefined
            ? formatContracts(
                this.baseQuantityToContracts(
                    rules,
                    (await this.normalizeQuantity(parsed.instId, changes.quantity)).baseQuantity
                )
            )
            : undefined

        await this.client.amendOrder({
            instId: parsed.instId,
            ordId: parsed.rawId,
            newPx,
            newSz,
        })

        const order = await this.client.getOrder(parsed.instId, parsed.rawId)
        return await this.mapExecutionResult(parsed.instId, order)
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
        const instId = normalizeInstrument(instrument)
        const positions = await this.getPositions()
        const position = positions.find((entry) => entry.instrument === instId)

        if (!position) {
            const errorDetail = createExecutionErrorDetail("pre_validation", `No OKX swap position found for ${instId}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument: instId,
                },
            })

            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        return await this.closeProviderPosition(position)
    }

    async closeProviderPosition(position: Position): Promise<ExecutionResult> {
        const instId = normalizeInstrument(position.instrument)
        await this.cancelProtectionOrders(instId, position.side)
        const sizing = await this.normalizeQuantity(instId, position.quantity)
        const ack = await this.client.placeOrder({
            instId,
            tdMode: this.config.marginMode,
            side: position.side === "long" ? "sell" : "buy",
            ordType: "market",
            sz: formatContracts(sizing.contracts),
            posSide: this.resolvePositionPosSide(position.side),
            reduceOnly: true,
        })

        const order = await this.client.getOrder(instId, ack.ordId)
        return await this.mapExecutionResult(instId, order)
    }

    async getRecentPositionClosures(): Promise<ProviderPositionClosure[]> {
        const fills = await this.client.getFillsHistory("SWAP", {
            begin: Date.now() - 24 * 60 * 60 * 1000,
            limit: 100,
        })
        const closureFills = fills.filter(isOKXClosingFill)
        const grouped = new Map<string, OKXFill[]>()

        for (const fill of closureFills) {
            const key = `${fill.instId}:${fill.posSide ?? "net"}:${fill.ordId || fill.tradeId}:${resolveOKXClosurePositionSide(fill)}`
            const existing = grouped.get(key) ?? []
            existing.push(fill)
            grouped.set(key, existing)
        }

        const closures: ProviderPositionClosure[] = []
        for (const group of grouped.values()) {
            const first = group[0]
            if (!first) {
                continue
            }

            const rules = await this.getInstrumentRules(first.instId)
            const contracts = group.reduce((sum, fill) => sum + Math.abs(Number(fill.fillSz)), 0)
            const quantity = this.contractsToBaseQuantity(rules, contracts)
            if (!Number.isFinite(quantity) || quantity <= 0 || contracts <= 0) {
                continue
            }

            const weightedPrice = group.reduce((sum, fill) => {
                const size = Math.abs(Number(fill.fillSz))
                return sum + size * Number(fill.fillPx)
            }, 0) / contracts
            const closedAt = Math.max(...group.map((fill) => Number(fill.ts)).filter(Number.isFinite))

            closures.push({
                instrument: first.instId,
                side: resolveOKXClosurePositionSide(first),
                quantity,
                fillPrice: weightedPrice,
                closedAt: Number.isFinite(closedAt) ? closedAt : Date.now(),
                metadata: {
                    orderId: first.ordId,
                    tradeIds: group.map((fill) => fill.tradeId).filter(Boolean),
                    side: first.side,
                    posSide: first.posSide,
                    fillPnl: sumOptionalNumberStrings(group.map((fill) => fill.fillPnl)),
                    fee: sumOptionalNumberStrings(group.map((fill) => fill.fee)),
                    feeCcy: first.feeCcy,
                    source: "okx_fills_history",
                },
            })
        }

        return closures.sort((left, right) => right.closedAt - left.closedAt)
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const parsed = parseCompositeOrderId(orderId)
        if (!parsed) {
            const errorDetail = createExecutionErrorDetail("pre_validation", `Unsupported OKX order id format: ${orderId}`, {
                code: "INVALID_ORDER_ID",
                retryable: false,
                details: {
                    orderId,
                },
            })

            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        if (parsed.kind === "algo") {
            const algoOrders = await this.client.getAlgoOrdersPending("SWAP", parsed.instId)
            const order = algoOrders.find((entry) => entry.algoId === parsed.rawId)

            if (!order) {
                return {
                    orderId,
                    status: "cancelled",
                    filledQuantity: 0,
                    timestamp: Date.now(),
                }
            }

            return {
                orderId,
                status: mapOKXAlgoOrderStatus(order.state),
                filledQuantity: 0,
                timestamp: parseUnixMs(order.uTime) ?? Date.now(),
            }
        }

        const order = await this.client.getOrder(parsed.instId, parsed.rawId)
        return await this.mapExecutionResult(parsed.instId, order)
    }

    async getMarketPrice(symbol: string): Promise<OKXMarketPrice> {
        const instId = normalizeInstrument(symbol)
        const current = await this.fetchRawMarketPrice(instId)
        const snapshots = this.executionCostTracker.needsWarmup(this.buildExecutionCostSnapshot(current))
            ? await this.collectMarketPriceSnapshots(instId, current, 3)
            : [this.buildExecutionCostSnapshot(current)]
        const executionCost = this.executionCostTracker.assessSnapshots(snapshots)

        return {
            ...current,
            executionCost,
        }
    }

    async getOrderBook(
        symbol: string,
        limit = 20
    ): Promise<{
        symbol: string
        bids: Array<{ price: number; quantity: number }>
        asks: Array<{ price: number; quantity: number }>
        timestamp?: number
    }> {
        const instId = normalizeInstrument(symbol)
        const [depth, rules] = await Promise.all([
            this.client.getOrderBook(instId, limit),
            this.getInstrumentRules(instId),
        ])

        return {
            symbol: instId,
            bids: mapDepthSide(depth.bids, rules),
            asks: mapDepthSide(depth.asks, rules),
            timestamp: parseUnixMs(depth.ts),
        }
    }

    async getCurrentMarkPrice(symbol: string): Promise<number> {
        const mark = await this.client.getMarkPrice(normalizeInstrument(symbol))
        return Number(mark.markPx)
    }

    async getCurrentFundingRate(symbol: string): Promise<number> {
        const funding = await this.client.getFundingRate(normalizeInstrument(symbol))
        return Number(funding.fundingRate)
    }

    async verify(intent: OrderIntent): Promise<PriceVerification> {
        const instId = normalizeInstrument(intent.instrument)
        const marketPrice = await this.getMarketPrice(instId)
        const mid = marketPrice.bestBid > 0 && marketPrice.bestAsk > 0
            ? (marketPrice.bestBid + marketPrice.bestAsk) / 2
            : marketPrice.markPrice
        const proposedPrice = resolveVerificationPrice(intent)
        const drift = proposedPrice !== undefined ? proposedPrice - mid : undefined
        const driftPercent = mid > 0 && drift !== undefined
            ? (drift / mid) * 100
            : undefined

        return {
            ok: true,
            status: proposedPrice === undefined ? "skipped" : undefined,
            livePrices: {
                bid: marketPrice.bestBid,
                ask: marketPrice.bestAsk,
                mid,
                spread: marketPrice.spread,
            },
            proposedPrice,
            drift,
            driftPercent,
            executionCost: marketPrice.executionCost,
            message: proposedPrice === undefined
                ? "Captured live OKX swap market prices before submission. No limit price was provided for drift comparison."
                : `Compared proposed OKX swap price ${proposedPrice} against live midpoint ${mid}.`,
            details: {
                instrument: instId,
                markPrice: marketPrice.markPrice,
                lastPrice: marketPrice.lastPrice,
                fundingRate: marketPrice.fundingRate,
                nextFundingTime: marketPrice.nextFundingTime,
            },
        }
    }

    async getMarketSnapshot(symbols: string[]): Promise<OKXMarketSnapshot[]> {
        return await Promise.all(
            symbols.map(async (symbol) => {
                const market = await this.getMarketPrice(symbol)

                return {
                    instrument: normalizeInstrument(symbol),
                    bid: market.bestBid,
                    ask: market.bestAsk,
                    markPrice: market.markPrice,
                    fundingRate: market.fundingRate ?? 0,
                    executionCost: market.executionCost,
                } satisfies OKXMarketSnapshot
            })
        )
    }

    private async fetchRawMarketPrice(symbol: string): Promise<Omit<OKXMarketPrice, "executionCost">> {
        const [ticker, mark, funding] = await Promise.all([
            this.client.getTicker(symbol),
            this.client.getMarkPrice(symbol),
            this.client.getFundingRate(symbol).catch(async () => {
                const history = await this.client.getFundingRateHistory(symbol, 1)
                return history[0]
            }),
        ])

        const bestBid = Number(ticker.bidPx)
        const bestAsk = Number(ticker.askPx)

        return {
            symbol,
            markPrice: Number(mark.markPx),
            lastPrice: Number(ticker.last),
            bestBid,
            bestAsk,
            spread: Math.max(bestAsk - bestBid, 0),
            fundingRate: funding?.fundingRate !== undefined ? Number(funding.fundingRate) : undefined,
            nextFundingTime: funding?.nextFundingTime !== undefined ? Number(funding.nextFundingTime) : undefined,
        }
    }

    private async collectMarketPriceSnapshots(
        symbol: string,
        current: Omit<OKXMarketPrice, "executionCost">,
        sampleCount: number
    ): Promise<ExecutionCostSnapshot[]> {
        const snapshots = [this.buildExecutionCostSnapshot(current)]
        while (snapshots.length < sampleCount) {
            snapshots.push(this.buildExecutionCostSnapshot(
                await this.fetchRawMarketPrice(symbol)
            ))
        }
        return snapshots
    }

    private buildExecutionCostSnapshot(
        marketPrice: Omit<OKXMarketPrice, "executionCost">
    ): ExecutionCostSnapshot {
        const midpoint = marketPrice.bestBid > 0 && marketPrice.bestAsk > 0
            ? (marketPrice.bestBid + marketPrice.bestAsk) / 2
            : marketPrice.markPrice

        return {
            app: "okx-swap",
            instrument: marketPrice.symbol,
            instrumentClass: "perpetual_swap",
            capturedAt: Date.now(),
            bestBid: marketPrice.bestBid,
            bestAsk: marketPrice.bestAsk,
            midpoint,
            referencePrice: midpoint > 0 ? midpoint : marketPrice.markPrice,
            absoluteSpread: marketPrice.spread,
            nativeSpread: marketPrice.spread,
            nativeSpreadUnit: "price",
        }
    }

    async normalizeQuantity(
        instrument: string,
        quantity: number
    ): Promise<NormalizedOrderSize> {
        const instId = normalizeInstrument(instrument)
        const rules = await this.getInstrumentRules(instId)
        const contracts = this.baseQuantityToContracts(rules, quantity)
        const normalizedContracts = floorToStep(contracts, rules.lotSize)

        if (!Number.isFinite(normalizedContracts) || normalizedContracts < rules.minContracts) {
            return {
                contracts: 0,
                baseQuantity: 0,
            }
        }

        return {
            contracts: normalizedContracts,
            baseQuantity: this.contractsToBaseQuantity(rules, normalizedContracts),
        }
    }

    async normalizePrice(
        instrument: string,
        price: number
    ): Promise<number> {
        const rules = await this.getInstrumentRules(normalizeInstrument(instrument))
        return roundToStep(price, rules.tickSize)
    }

    async updateProtectionOrders(config: {
        instrument: string
        stopLoss?: number
        takeProfit?: number
    }): Promise<{ cancelledOrderIds: string[]; createdOrderIds: string[] }> {
        const instId = normalizeInstrument(config.instrument)
        const positions = await this.getPositions()
        const position = positions.find((entry) => entry.instrument === instId)

        if (!position) {
            throw createExecutionError("pre_validation", `No open OKX swap position found for ${instId}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument: instId,
                },
            })
        }

        const existingOrders = await this.client.getAlgoOrdersPending("SWAP", instId)
        const cancelledOrderIds: string[] = []

        const relevantOrders = existingOrders.filter((order) =>
            this.matchesPositionProtection(order, position.side)
        )

        if (relevantOrders.length > 0) {
            const acks = await this.client.cancelAlgoOrders(
                relevantOrders.map((order) => ({
                    algoId: order.algoId,
                    instId: order.instId,
                }))
            )

            cancelledOrderIds.push(
                ...acks.map((ack) => toCompositeOrderId("algo", instId, ack.algoId))
            )
        }

        const createdOrderIds: string[] = []
        const closeSide = position.side === "long" ? "sell" : "buy"
        const posSide = this.resolvePositionPosSide(position.side)
        const rules = await this.getInstrumentRules(instId)
        const contracts = this.baseQuantityToContracts(rules, position.quantity)
        const size = formatContracts(contracts)

        if (config.stopLoss !== undefined && config.takeProfit !== undefined) {
            const ack = await this.client.placeAlgoOrder({
                instId,
                tdMode: this.config.marginMode,
                side: closeSide,
                posSide,
                ordType: "oco",
                sz: size,
                slTriggerPx: formatNumber(await this.normalizePrice(instId, config.stopLoss)),
                slOrdPx: "-1",
                tpTriggerPx: formatNumber(await this.normalizePrice(instId, config.takeProfit)),
                tpOrdPx: "-1",
            })
            createdOrderIds.push(toCompositeOrderId("algo", instId, ack.algoId))
        } else if (config.stopLoss !== undefined) {
            const ack = await this.client.placeAlgoOrder({
                instId,
                tdMode: this.config.marginMode,
                side: closeSide,
                posSide,
                ordType: "conditional",
                sz: size,
                slTriggerPx: formatNumber(await this.normalizePrice(instId, config.stopLoss)),
                slOrdPx: "-1",
            })
            createdOrderIds.push(toCompositeOrderId("algo", instId, ack.algoId))
        } else if (config.takeProfit !== undefined) {
            const ack = await this.client.placeAlgoOrder({
                instId,
                tdMode: this.config.marginMode,
                side: closeSide,
                posSide,
                ordType: "conditional",
                sz: size,
                tpTriggerPx: formatNumber(await this.normalizePrice(instId, config.takeProfit)),
                tpOrdPx: "-1",
            })
            createdOrderIds.push(toCompositeOrderId("algo", instId, ack.algoId))
        }

        if (createdOrderIds.length > 0) {
            await this.assertProtectionOrdersPending(instId, createdOrderIds)
        }

        return {
            cancelledOrderIds,
            createdOrderIds,
        }
    }

    private async assertProtectionOrdersPending(
        instId: string,
        createdOrderIds: string[]
    ): Promise<void> {
        const pending = await this.client.getAlgoOrdersPending("SWAP", instId)
        const pendingIds = new Set(
            pending.map((order) => toCompositeOrderId("algo", instId, order.algoId))
        )
        const missing = createdOrderIds.filter((orderId) => !pendingIds.has(orderId))

        if (missing.length === 0) {
            return
        }

        throw createExecutionError("venue", `OKX protection order placement did not appear in pending algo orders for ${instId}`, {
            code: "PROTECTION_NOT_PENDING",
            retryable: false,
            details: {
                instId,
                createdOrderIds,
                pendingOrderIds: Array.from(pendingIds),
                missing,
            },
        })
    }

    async closeAllPositions(): Promise<{ closed: number; results: ExecutionResult[] }> {
        const positions = await this.getPositions()
        const results: ExecutionResult[] = []

        for (const position of positions) {
            results.push(await this.closePosition(position.instrument))
        }

        return {
            closed: results.filter((result) => result.status === "filled" || result.status === "pending").length,
            results,
        }
    }

    private async assertTradingPreconditions(): Promise<void> {
        if (this.accountConfigValidated) {
            return
        }

        const accountConfig = await this.client.getAccountConfig()

        if (accountConfig.acctLv === "1") {
            throw createExecutionError(
                "pre_validation",
                "OKX account is in simple mode. Swap trading requires a derivatives-capable account mode.",
                {
                    code: "ACCOUNT_MODE_UNSUPPORTED",
                    retryable: false,
                    details: {
                        acctLv: accountConfig.acctLv,
                    },
                }
            )
        }

        if (accountConfig.posMode !== this.config.positionMode) {
            throw createExecutionError(
                "pre_validation",
                `OKX account posMode ${accountConfig.posMode} does not match configured position mode ${this.config.positionMode}`,
                {
                    code: "POSITION_MODE_MISMATCH",
                    retryable: false,
                    details: {
                        expected: this.config.positionMode,
                        received: accountConfig.posMode,
                    },
                }
            )
        }

        this.accountConfigValidated = true
    }

    private async cancelProtectionOrders(instId: string, side?: Position["side"]): Promise<void> {
        const algoOrders = await this.client.getAlgoOrdersPending("SWAP", instId)
        const relevantOrders = side
            ? algoOrders.filter((order) => this.matchesPositionProtection(order, side))
            : algoOrders

        if (relevantOrders.length === 0) {
            return
        }

        await this.client.cancelAlgoOrders(
            relevantOrders.map((order) => ({
                algoId: order.algoId,
                instId: order.instId,
            }))
        )
    }

    private matchesPositionProtection(order: OKXAlgoOrder, side: Position["side"]): boolean {
        return this.getProtectionKey(order.instId, order.posSide) === this.getProtectionKey(
            order.instId,
            this.resolvePositionPosSide(side)
        )
    }

    private async getInstrumentRules(instId: string): Promise<OKXInstrumentRules> {
        const cached = this.instrumentRulesCache.get(instId)
        if (cached) {
            return cached
        }

        const instruments = await this.client.getInstruments("SWAP", instId)
        const instrument = instruments.find((entry) => entry.instId === instId)

        if (!instrument) {
            throw createExecutionError("venue", `OKX instrument not found: ${instId}`, {
                code: "INSTRUMENT_NOT_FOUND",
                retryable: false,
                details: {
                    instId,
                },
            })
        }

        const rules = parseInstrumentRules(instrument)
        this.instrumentRulesCache.set(instId, rules)
        return rules
    }

    private baseQuantityToContracts(
        rules: OKXInstrumentRules,
        quantity: number
    ): number {
        this.assertSupportedContractModel(rules)
        return quantity / rules.contractValue
    }

    private contractsToBaseQuantity(
        rules: OKXInstrumentRules,
        contracts: number
    ): number {
        this.assertSupportedContractModel(rules)
        return contracts * rules.contractValue
    }

    private assertSupportedContractModel(rules: OKXInstrumentRules): void {
        if (rules.instType !== "SWAP") {
            throw createExecutionError("pre_validation", `Unsupported OKX instrument type for ${rules.instId}: ${rules.instType}`, {
                code: "UNSUPPORTED_INSTRUMENT_TYPE",
                retryable: false,
            })
        }

        if (rules.state !== "live") {
            throw createExecutionError("pre_validation", `OKX instrument ${rules.instId} is not live`, {
                code: "INSTRUMENT_NOT_LIVE",
                retryable: false,
            })
        }

        if (
            rules.contractValueCurrency &&
            rules.baseCcy &&
            rules.contractValueCurrency !== rules.baseCcy
        ) {
            throw createExecutionError(
                "pre_validation",
                `Unsupported OKX contract sizing model for ${rules.instId}. contract currency ${rules.contractValueCurrency} does not match base currency ${rules.baseCcy}.`,
                {
                    code: "UNSUPPORTED_CONTRACT_MODEL",
                    retryable: false,
                    details: {
                        instId: rules.instId,
                        contractValueCurrency: rules.contractValueCurrency,
                        baseCcy: rules.baseCcy,
                    },
                }
            )
        }
    }

    private resolveEntryPosSide(side: "buy" | "sell"): OKXApiPosSide | undefined {
        if (this.config.positionMode === "net_mode") {
            return "net"
        }

        return side === "buy" ? "long" : "short"
    }

    private resolveLeveragePosSide(side: "buy" | "sell"): "long" | "short" | undefined {
        if (this.config.positionMode === "net_mode") {
            return undefined
        }

        return side === "buy" ? "long" : "short"
    }

    private resolvePositionPosSide(side: Position["side"]): OKXApiPosSide {
        if (this.config.positionMode === "net_mode") {
            return "net"
        }

        return side === "long" ? "long" : "short"
    }

    private getProtectionKey(
        instId: string,
        posSide: string | undefined
    ): string {
        return `${instId}:${posSide ?? "net"}`
    }

    private async buildAttachedProtectionOrders(
        instId: string,
        intent: OrderIntent
    ): Promise<OKXAttachedAlgoOrderParams[] | undefined> {
        if (isCloseAction(intent)) {
            return undefined
        }

        const stopLoss = readFiniteMetadataNumber(intent.metadata, "stopLoss")
        const takeProfit = readFiniteMetadataNumber(intent.metadata, "takeProfit")

        if (stopLoss === undefined && takeProfit === undefined) {
            return undefined
        }

        return [
            {
                slTriggerPx: stopLoss !== undefined
                    ? formatNumber(await this.normalizePrice(instId, stopLoss))
                    : undefined,
                slOrdPx: stopLoss !== undefined ? "-1" : undefined,
                tpTriggerPx: takeProfit !== undefined
                    ? formatNumber(await this.normalizePrice(instId, takeProfit))
                    : undefined,
                tpOrdPx: takeProfit !== undefined ? "-1" : undefined,
            },
        ]
    }

    private async mapExecutionResult(
        instId: string,
        order: OKXOrder
    ): Promise<ExecutionResult> {
        const rules = await this.getInstrumentRules(instId)
        const filledQuantity = this.contractsToBaseQuantity(rules, Number(order.accFillSz))
        const fillPrice = isFiniteNumberString(order.avgPx) && Number(order.avgPx) > 0
            ? Number(order.avgPx)
            : isFiniteNumberString(order.px) && Number(order.px) > 0
                ? Number(order.px)
                : undefined
        const status = mapOKXOrderStatus(order.state)
        const errorDetail = status === "rejected"
            ? createExecutionErrorDetail("venue", order.state, {
                code: order.state,
                retryable: false,
                details: {
                    instId,
                    ordId: order.ordId,
                },
            })
            : undefined

        return {
            orderId: toCompositeOrderId("order", instId, order.ordId),
            status,
            filledQuantity,
            fillPrice,
            timestamp: parseUnixMs(order.uTime) ?? parseUnixMs(order.cTime) ?? Date.now(),
            error: errorDetail ? formatExecutionError(errorDetail) : undefined,
            errorDetail,
        }
    }

    private async mapAccountState(
        balance: OKXAccountBalance,
        positions: OKXPosition[]
    ): Promise<AccountState> {
        const equity = readFiniteNumberString(balance.totalEq) ?? 0
        const positionOpenPnl = positions.reduce((sum, position) =>
            sum + (readFiniteNumberString(position.upl) ?? 0), 0)
        const accountOpenPnl = readFiniteNumberString(balance.upl)
        const openPnl = accountOpenPnl !== undefined && accountOpenPnl !== 0
            ? accountOpenPnl
            : positionOpenPnl
        const accountMarginUsed = firstDefinedNumber(balance.imr, balance.mmr)
        const positionMarginUsed = await this.resolvePositionMarginUsed(positions)
        const marginUsed = accountMarginUsed !== undefined && accountMarginUsed !== 0
            ? accountMarginUsed
            : positionMarginUsed
        const available = firstDefinedNumber(
            balance.availEq,
            balance.adjEq,
            balance.details[0]?.availEq,
            balance.details[0]?.availBal,
            balance.details[0]?.cashBal
        ) ?? Math.max(equity - marginUsed, 0)

        return {
            balance: Math.max(equity - openPnl, 0),
            equity,
            buyingPower: available,
            marginUsed,
            marginAvailable: available,
            openPnl,
            dayPnl: 0,
        }
    }

    private async resolvePositionMarginUsed(positions: OKXPosition[]): Promise<number> {
        let total = 0

        for (const position of positions) {
            const providerMargin = firstDefinedNumber(position.imr, position.margin, position.mmr)
            if (providerMargin !== undefined) {
                total += providerMargin
                continue
            }

            const contracts = Math.abs(readFiniteNumberString(position.pos) ?? 0)
            const markPrice = readFiniteNumberString(position.markPx) ?? 0
            const leverage = readFiniteNumberString(position.lever)
            if (contracts <= 0 || markPrice <= 0 || leverage === undefined || leverage <= 0) {
                continue
            }

            const rules = await this.getInstrumentRules(position.instId)
            total += this.contractsToBaseQuantity(rules, contracts) * markPrice / leverage
        }

        return total
    }
}

function resolvePositionSide(
    position: OKXPosition,
    positionMode: OKXPositionMode
): Position["side"] {
    if (positionMode === "long_short_mode") {
        if (position.posSide === "long") {
            return "long"
        }

        return "short"
    }

    return Number(position.pos) >= 0 ? "long" : "short"
}

function parseInstrumentRules(
    instrument: OKXInstrument
): OKXInstrumentRules {
    const tickSize = Number(instrument.tickSz)
    const lotSize = Number(instrument.lotSz)
    const minContracts = Number(instrument.minSz)
    const contractValue = Number(instrument.ctVal)

    if (
        !Number.isFinite(tickSize) ||
        !Number.isFinite(lotSize) ||
        !Number.isFinite(minContracts) ||
        !Number.isFinite(contractValue) ||
        tickSize <= 0 ||
        lotSize <= 0 ||
        minContracts <= 0 ||
        contractValue <= 0
    ) {
        throw createExecutionError("venue", `Incomplete OKX instrument rules for ${instrument.instId}`, {
            code: "INSTRUMENT_RULES_INCOMPLETE",
            retryable: false,
            details: {
                instId: instrument.instId,
                tickSz: instrument.tickSz,
                lotSz: instrument.lotSz,
                minSz: instrument.minSz,
                ctVal: instrument.ctVal,
            },
        })
    }

    return {
        instId: instrument.instId,
        baseCcy: instrument.baseCcy,
        quoteCcy: instrument.quoteCcy,
        settleCcy: instrument.settleCcy,
        tickSize,
        lotSize,
        minContracts,
        contractValue,
        contractValueCurrency: instrument.ctValCcy,
        instType: instrument.instType,
        state: instrument.state,
    }
}

function mapOKXOrderStatus(state: string): ExecutionResult["status"] {
    switch (state) {
        case "live":
            return "pending"
        case "partially_filled":
            return "partially_filled"
        case "filled":
            return "filled"
        case "canceled":
        case "mmp_canceled":
            return "cancelled"
        case "order_failed":
            return "rejected"
        default:
            return "pending"
    }
}

function mapOKXAlgoOrderStatus(state?: string): ExecutionResult["status"] {
    switch (state) {
        case "effective":
        case "filled":
            return "filled"
        case "order_failed":
            return "rejected"
        case "canceled":
            return "cancelled"
        default:
            return "pending"
    }
}

function mapToOKXOrderType(
    orderType: OrderIntent["orderType"],
    timeInForce: OrderIntent["timeInForce"]
): Exclude<OKXOrderType, "conditional"> {
    if (orderType === "market") {
        return "market"
    }

    if (timeInForce === "ioc") {
        return "ioc"
    }

    if (timeInForce === "fok") {
        return "fok"
    }

    if (timeInForce === "day") {
        throw createExecutionError(
            "pre_validation",
            "OKX swap does not support implicit day-end expiry semantics. Use gtc, ioc, or fok with explicit cancellation policy.",
            {
                code: "UNSUPPORTED_TIME_IN_FORCE",
                retryable: false,
                details: {
                    timeInForce,
                },
            }
        )
    }

    return "limit"
}

function readFiniteMetadataNumber(
    metadata: OrderIntent["metadata"],
    key: string
): number | undefined {
    const value = metadata?.[key]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function mapDepthSide(
    levels: OKXOrderBookLevel[],
    rules: OKXInstrumentRules
): Array<{ price: number; quantity: number }> {
    return levels.map(([price, size]) => ({
        price: Number(price),
        quantity: Number(size) * rules.contractValue,
    }))
}

function resolveVerificationPrice(intent: OrderIntent): number | undefined {
    if (intent.orderType === "limit" || intent.orderType === "stop_limit") {
        return intent.limitPrice
    }

    return undefined
}

function parseCompositeOrderId(orderId: string): CompositeOrderId | null {
    const [kind, instId, rawId] = orderId.split(":")

    if (
        (kind !== "order" && kind !== "algo") ||
        !instId ||
        !rawId
    ) {
        return null
    }

    return {
        kind,
        instId,
        rawId,
    }
}

function toCompositeOrderId(
    kind: CompositeOrderId["kind"],
    instId: string,
    rawId: string
): string {
    return `${kind}:${instId}:${rawId}`
}

function floorToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
        return 0
    }

    const precision = countDecimals(step)
    const normalized = Math.floor(value / step) * step
    return Number(normalized.toFixed(precision))
}

function roundToStep(value: number, step: number): number {
    const precision = countDecimals(step)
    return Number((Math.round(value / step) * step).toFixed(precision))
}

function countDecimals(value: number): number {
    const asString = value.toString()
    const dotIndex = asString.indexOf(".")

    if (dotIndex === -1) {
        return 0
    }

    return asString.length - dotIndex - 1
}

function firstDefinedNumber(...values: Array<string | undefined>): number | undefined {
    for (const value of values) {
        if (isFiniteNumberString(value)) {
            return Number(value)
        }
    }

    return undefined
}

function readFiniteNumberString(value?: string): number | undefined {
    return isFiniteNumberString(value) ? Number(value) : undefined
}

function isOKXClosingFill(fill: OKXFill): boolean {
    if (!isFiniteNumberString(fill.fillSz) ||
        Number(fill.fillSz) <= 0 ||
        !isFiniteNumberString(fill.fillPx) ||
        !isFiniteNumberString(fill.ts)
    ) {
        return false
    }

    if (fill.posSide === "long") {
        return fill.side === "sell"
    }

    if (fill.posSide === "short") {
        return fill.side === "buy"
    }

    return isFiniteNumberString(fill.fillPnl)
}

function resolveOKXClosurePositionSide(fill: OKXFill): Position["side"] {
    if (fill.posSide === "long") {
        return "long"
    }

    if (fill.posSide === "short") {
        return "short"
    }

    return fill.side === "sell" ? "long" : "short"
}

function sumOptionalNumberStrings(values: Array<string | undefined>): number | undefined {
    let total = 0
    let found = false

    for (const value of values) {
        if (!isFiniteNumberString(value)) {
            continue
        }

        total += Number(value)
        found = true
    }

    return found ? total : undefined
}

function parseUnixMs(value?: string): number | undefined {
    if (!isFiniteNumberString(value)) {
        return undefined
    }

    return Number(value)
}

function formatContracts(value: number): string {
    return formatNumber(value)
}

function formatNumber(value: number): string {
    return value.toString()
}

function isFiniteNumberString(value?: string): value is string {
    if (value === undefined || value === "") {
        return false
    }

    const parsed = Number(value)
    return Number.isFinite(parsed)
}

function isCloseAction(intent: OrderIntent): boolean {
    const action = intent.metadata?.action
    return action === "close" || action === "close_position" || action === "cancel" || action === "cancel_order"
}

function resolveLeverage(intent: OrderIntent): number | undefined {
    const leverage = intent.metadata?.leverage
    if (typeof leverage !== "number") {
        return undefined
    }

    return Math.floor(leverage)
}

function normalizeInstrument(value: string): string {
    return value.trim().toUpperCase()
}
