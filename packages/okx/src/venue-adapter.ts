import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    type AccountState,
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
    type OKXApiPosSide,
    type OKXMarginMode,
    type OKXOrder,
    type OKXPositionMode,
} from "./okx-client"
import type { OKXMarketSnapshot } from "./market-context"
import {
    floorToStep,
    formatContracts,
    formatNumber,
    isCloseAction,
    mapDepthSide,
    mapOKXAlgoOrderStatus,
    mapToOKXOrderType,
    normalizeInstrument,
    parseCompositeOrderId,
    parseInstrumentRules,
    parseUnixMs,
    resolveLeverage,
    resolveVerificationPrice,
    roundToStep,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"
import {
    readOKXMarketPrice,
    type OKXMarketPrice,
} from "./venue-adapter-market"
import { mapOKXAccountState } from "./venue-adapter-account"
import { mapOKXRecentPositionClosures } from "./venue-adapter-closures"
import { mapOKXExecutionResult } from "./venue-adapter-execution-results"
import { mapOKXPositions } from "./venue-adapter-positions"
import {
    buildOKXAttachedProtectionOrders,
    buildOKXProtectionKey,
    cancelOKXProtectionOrders,
    updateOKXProtectionOrders,
} from "./venue-adapter-protection"
import { mapOKXWorkingOrders } from "./venue-adapter-working-orders"

interface NormalizedOrderSize {
    contracts: number
    baseQuantity: number
}

export type { OKXMarketPrice } from "./venue-adapter-market"

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

        return await mapOKXPositions({
            positions,
            algoOrders,
            positionMode: this.config.positionMode,
            getInstrumentRules: (instId) => this.getInstrumentRules(instId),
            contractsToBaseQuantity: (rules, contracts) =>
                this.contractsToBaseQuantity(rules, contracts),
            resolvePositionPosSide: (side) => this.resolvePositionPosSide(side),
            getProtectionKey: buildOKXProtectionKey,
        })
    }

    async getAccountState(): Promise<AccountState> {
        const [balance, positions] = await Promise.all([
            this.client.getBalance(),
            this.client.getPositions("SWAP"),
        ])
        return await mapOKXAccountState({
            balance,
            positions,
            getInstrumentRules: (instId) => this.getInstrumentRules(instId),
            contractsToBaseQuantity: (rules, contracts) =>
                this.contractsToBaseQuantity(rules, contracts),
        })
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const [orders, algoOrders, positions] = await Promise.all([
            this.client.getOrdersPending("SWAP"),
            this.client.getAlgoOrdersPending("SWAP"),
            this.getPositions(),
        ])

        return await mapOKXWorkingOrders({
            orders,
            algoOrders,
            positions,
            getInstrumentRules: (instId) => this.getInstrumentRules(instId),
            contractsToBaseQuantity: (rules, contracts) =>
                this.contractsToBaseQuantity(rules, contracts),
            resolvePositionPosSide: (side) => this.resolvePositionPosSide(side),
            getProtectionKey: buildOKXProtectionKey,
        })
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
        const attachAlgoOrds = await buildOKXAttachedProtectionOrders({
            instId,
            intent,
            normalizePrice: (price) => this.normalizePrice(instId, price),
        })
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
        await cancelOKXProtectionOrders({
            client: this.client,
            instId,
            side: position.side,
            resolvePositionPosSide: (side) => this.resolvePositionPosSide(side),
        })
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
        return await mapOKXRecentPositionClosures({
            fills,
            getInstrumentRules: (instId) => this.getInstrumentRules(instId),
            contractsToBaseQuantity: (rules, contracts) =>
                this.contractsToBaseQuantity(rules, contracts),
        })
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
        return await readOKXMarketPrice({
            client: this.client,
            executionCostTracker: this.executionCostTracker,
            symbol: instId,
        })
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
        return await updateOKXProtectionOrders({
            client: this.client,
            instrument: instId,
            stopLoss: config.stopLoss,
            takeProfit: config.takeProfit,
            marginMode: this.config.marginMode,
            getPositions: () => this.getPositions(),
            getInstrumentRules: (instrument) => this.getInstrumentRules(instrument),
            baseQuantityToContracts: (rules, quantity) =>
                this.baseQuantityToContracts(rules, quantity),
            normalizePrice: (price) => this.normalizePrice(instId, price),
            resolvePositionPosSide: (side) => this.resolvePositionPosSide(side),
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

    private async mapExecutionResult(
        instId: string,
        order: OKXOrder
    ): Promise<ExecutionResult> {
        return await mapOKXExecutionResult({
            instId,
            order,
            getInstrumentRules: (instrument) => this.getInstrumentRules(instrument),
            contractsToBaseQuantity: (rules, contracts) =>
                this.contractsToBaseQuantity(rules, contracts),
        })
    }
}
