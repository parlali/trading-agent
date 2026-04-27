/**
 * MT5 venue adapter -- implements the shared VenueAdapter interface
 * by proxying all calls to the Python worker via MT5Client.
 *
 * Key difference from Alpaca/Polymarket: MT5 orders are typically market
 * orders that fill immediately, so the order lifecycle is simpler.
 */

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
    MT5Client,
    type MT5OpenOrder,
    type MT5OrderResult,
    type MT5PositionClosure,
    type MT5Position,
    type MT5SymbolInfo,
    type MT5WorkerCredentials,
} from "./mt5-client"
import {
    resolveMT5NormalizedSpread,
    toMT5MarketSnapshot,
    type MT5MarketSnapshot,
} from "./market-context"

export class MT5VenueAdapter implements VenueAdapter, PriceVerifier {
    private lastConnectedAt = 0
    private readonly CONNECTION_TTL = 60_000

    constructor(
        private readonly client: MT5Client,
        private readonly credentials: MT5WorkerCredentials,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

    /**
     * Ensure the Python worker has an active MT5 connection.
     * Called lazily before the first broker operation in a run.
     */
    async ensureConnected(): Promise<void> {
        if (Date.now() - this.lastConnectedAt < this.CONNECTION_TTL) {
            return
        }
        const health = await this.client.getHealth()
        if (!health.connected || health.login !== this.credentials.login) {
            await this.client.connect(this.credentials)
        }
        this.lastConnectedAt = Date.now()
    }

    async getPositions(): Promise<Position[]> {
        await this.ensureConnected()
        const observedAt = Date.now()
        const raw = await this.client.getPositions()
        return raw.map((position) => mapMT5Position(position, observedAt))
    }

    async getAccountState(): Promise<AccountState> {
        await this.ensureConnected()
        const info = await this.client.getAccount()

        return {
            balance: info.balance,
            equity: info.equity,
            buyingPower: info.freeMargin,
            marginUsed: info.margin,
            marginAvailable: info.freeMargin,
            openPnl: info.profit,
            dayPnl: 0, // MT5 doesn't expose day P&L directly
        }
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        await this.ensureConnected()
        const observedAt = Date.now()
        const orders = await this.client.getOpenOrders()
        return orders.map((order) => mapMT5WorkingOrder(order, observedAt))
    }

    async getRecentPositionClosures(): Promise<ProviderPositionClosure[]> {
        await this.ensureConnected()
        const observedAt = Date.now()
        const closures = await this.client.getPositionClosures()
        return closures.map((closure) => mapMT5PositionClosure(closure, observedAt))
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        await this.ensureConnected()

        const result = await this.client.submitOrder({
            symbol: intent.instrument,
            side: intent.side,
            volume: intent.quantity,
            orderType: intent.orderType,
            price: intent.limitPrice ?? intent.stopPrice,
            stopLoss: intent.metadata?.stopLoss as number | undefined,
            takeProfit: intent.metadata?.takeProfit as number | undefined,
            magic: (intent.metadata?.magic as number) ?? 0,
            comment: (intent.metadata?.comment as string) ?? "",
        })

        return mapMT5SubmissionResult(this.client, result, intent)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        const ticket = Number(orderId)
        if (Number.isNaN(ticket)) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Invalid MT5 ticket number", {
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

        const result = await this.client.cancelOrder({ ticket })
        return this.client.mapOrderResultToExecution(result, {
            fallbackOrderId: orderId,
            successStatus: "cancelled",
            filledQuantity: 0,
        })
    }

    async cancelAllOrders(): Promise<{ cancelled: number; results: ExecutionResult[] }> {
        await this.ensureConnected()

        const response = await this.client.cancelAllOrders()

        return {
            cancelled: response.cancelled,
            results: response.results.map((result) =>
                this.client.mapOrderResultToExecution(result, {
                    fallbackOrderId: result.orderId,
                    successStatus: "cancelled",
                    filledQuantity: 0,
                })
            ),
        }
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        await this.ensureConnected()

        // In MT5, "modifying an order" typically means adjusting SL/TP on an open position
        const ticket = Number(orderId)
        if (Number.isNaN(ticket)) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Invalid MT5 ticket number", {
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

        const stopLoss = changes.stopPrice ?? (changes.metadata?.stopLoss as number | undefined)
        const takeProfit = changes.limitPrice ?? (changes.metadata?.takeProfit as number | undefined)

        if (stopLoss === undefined && takeProfit === undefined) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Provide newStopLoss, newTakeProfit, or both", {
                code: "MISSING_MODIFICATION_FIELDS",
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

        const result = await this.client.modifyPosition({
            ticket,
            stopLoss,
            takeProfit,
        })

        return this.client.mapOrderResultToExecution(result, {
            fallbackOrderId: orderId,
        })
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        const positions = await this.client.getPositions()
        const matchingPositions = positions.filter((position) => position.symbol === instrument)

        if (matchingPositions.length === 0) {
            const errorDetail = createExecutionErrorDetail("pre_validation", `No open MT5 position found for ${instrument}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument,
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

        const results = await Promise.all(
            matchingPositions.map(async (position) => {
                const result = await this.client.closePosition({ ticket: position.ticket })
                return this.client.mapOrderResultToExecution(result, {
                    fallbackOrderId: String(position.ticket),
                })
            })
        )

        return aggregateMT5CloseResults(instrument, results)
    }

    async closeProviderPosition(position: Position): Promise<ExecutionResult> {
        await this.ensureConnected()

        const ticket = readMT5Ticket(position)
        if (ticket === undefined) {
            const errorDetail = createExecutionErrorDetail("pre_validation", `No MT5 provider ticket found for ${position.instrument}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument: position.instrument,
                    providerPositionId: position.providerPositionId,
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

        const result = await this.client.closePosition({ ticket })
        return this.client.mapOrderResultToExecution(result, {
            fallbackOrderId: String(ticket),
        })
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        const ticket = Number(orderId)
        if (Number.isNaN(ticket)) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Invalid MT5 ticket number", {
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

        const status = await this.client.getOrderStatus(ticket)
        if (!status) {
            throw createExecutionError("venue", `MT5 order ${orderId} not found in order book or history`, {
                code: "ORDER_NOT_FOUND",
                retryable: false,
                details: {
                    orderId,
                },
            })
        }

        const mappedStatus = mapMT5OrderState(status.state)
        const filledQuantity = resolveMT5FilledQuantity(status, mappedStatus)
        const hasFilledQuantity = filledQuantity > 0
        const normalizedStatus = (mappedStatus === "filled" || mappedStatus === "partially_filled") && !hasFilledQuantity
            ? "pending"
            : mappedStatus

        return {
            orderId,
            status: normalizedStatus,
            filledQuantity: hasFilledQuantity ? filledQuantity : 0,
            fillPrice: hasFilledQuantity && status.price > 0 ? status.price : undefined,
            timestamp: Date.now(),
        }
    }

    async getSymbolInfo(symbol: string): Promise<MT5SymbolInfo | null> {
        await this.ensureConnected()
        const results = await this.client.getSymbolInfo([symbol])
        return results.length > 0 ? (results[0] ?? null) : null
    }

    async verify(intent: OrderIntent): Promise<PriceVerification> {
        const symbolInfo = await this.getSymbolInfo(intent.instrument)
        if (!symbolInfo) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: resolveMT5VerificationPrice(intent),
                message: `Symbol ${intent.instrument} not found or unavailable for MT5 price verification.`,
                details: {
                    instrument: intent.instrument,
                },
            }
        }

        const executionCost = await this.assessSymbolExecutionCost(symbolInfo)
        const mid = (symbolInfo.bid + symbolInfo.ask) / 2
        const comparisonPrice = resolveMT5ComparisonPrice(intent, symbolInfo)
        const proposedPrice = resolveMT5VerificationPrice(intent, symbolInfo)
        const drift = proposedPrice !== undefined ? proposedPrice - comparisonPrice : undefined
        const driftPercent = comparisonPrice > 0 && drift !== undefined
            ? (drift / comparisonPrice) * 100
            : undefined

        return {
            ok: true,
            livePrices: {
                bid: symbolInfo.bid,
                ask: symbolInfo.ask,
                mid,
                spread: Math.abs(symbolInfo.ask - symbolInfo.bid),
            },
            proposedPrice,
            drift,
            driftPercent,
            executionCost,
            message: proposedPrice !== undefined
                ? `Compared proposed MT5 price ${proposedPrice} against live executable price ${comparisonPrice}.`
                : "Captured live MT5 market prices before submission.",
            details: {
                instrument: symbolInfo.symbol,
                digits: symbolInfo.digits,
                point: symbolInfo.point,
                sidePrice: resolveMT5ComparisonPrice(intent, symbolInfo),
            },
        }
    }

    async getMarketSnapshot(symbols: string[]): Promise<MT5MarketSnapshot[]> {
        if (symbols.length === 0) {
            return []
        }

        await this.ensureConnected()
        const results = await this.client.getSymbolInfo(symbols)
        return await Promise.all(
            results.map(async (symbolInfo) => toMT5MarketSnapshot(
                symbolInfo,
                await this.assessSymbolExecutionCost(symbolInfo)
            ))
        )
    }

    /**
     * Close all open positions immediately.
     * Used by session-flat and reset flows.
     */
    async closeAllPositions(): Promise<{ closed: number; results: ExecutionResult[] }> {
        await this.ensureConnected()
        const response = await this.client.closeAllPositions()

        return {
            closed: response.closed,
            results: response.results.map((r) => this.client.mapOrderResultToExecution(r)),
        }
    }

    async assessSymbolExecutionCost(symbolInfo: MT5SymbolInfo): Promise<ExecutionCostAssessment> {
        const snapshots = this.executionCostTracker.needsWarmup(this.buildExecutionCostSnapshot(symbolInfo))
            ? await this.collectSymbolExecutionSnapshots(symbolInfo.symbol, symbolInfo, 3)
            : [this.buildExecutionCostSnapshot(symbolInfo)]

        return this.executionCostTracker.assessSnapshots(snapshots)
    }

    private async collectSymbolExecutionSnapshots(
        symbol: string,
        current: MT5SymbolInfo,
        sampleCount: number
    ): Promise<ExecutionCostSnapshot[]> {
        const snapshots = [this.buildExecutionCostSnapshot(current)]
        while (snapshots.length < sampleCount) {
            const next = await this.getSymbolInfo(symbol)
            if (!next) {
                break
            }
            snapshots.push(this.buildExecutionCostSnapshot(next))
        }
        return snapshots
    }

    private buildExecutionCostSnapshot(symbolInfo: MT5SymbolInfo): ExecutionCostSnapshot {
        const normalizedSpread = resolveMT5NormalizedSpread(symbolInfo)
        const midpoint = (symbolInfo.bid + symbolInfo.ask) / 2
        const instrument = symbolInfo.symbol.trim().toUpperCase()

        return {
            app: "mt5",
            instrument,
            instrumentClass: resolveMT5InstrumentClass(instrument),
            capturedAt: Date.now(),
            bestBid: symbolInfo.bid,
            bestAsk: symbolInfo.ask,
            midpoint,
            referencePrice: midpoint,
            absoluteSpread: Math.abs(symbolInfo.ask - symbolInfo.bid),
            nativeSpread: normalizedSpread.value,
            nativeSpreadUnit: normalizedSpread.unit,
        }
    }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const MT5_PROVIDER_FUTURE_SKEW_MS = 60_000

function mapMT5Position(raw: MT5Position, observedAt: number = Date.now()): Position {
    const openTime = normalizeMT5ProviderTimestamp(raw.openTime, observedAt)

    return {
        instrument: raw.symbol,
        providerPositionId: String(raw.ticket),
        side: raw.type === "buy" ? "long" : "short",
        quantity: raw.volume,
        entryPrice: raw.openPrice,
        currentPrice: raw.currentPrice,
        unrealizedPnl: raw.profit,
        stopLoss: raw.stopLoss > 0 ? raw.stopLoss : undefined,
        takeProfit: raw.takeProfit > 0 ? raw.takeProfit : undefined,
        metadata: {
            ticket: raw.ticket,
            identifier: raw.identifier,
            stopLoss: raw.stopLoss,
            takeProfit: raw.takeProfit,
            swap: raw.swap,
            commission: raw.commission,
            magic: raw.magic,
            comment: raw.comment,
            openTime,
        },
    }
}

function readMT5Ticket(position: Position): number | undefined {
    const fromProviderPositionId = Number(position.providerPositionId)
    if (Number.isInteger(fromProviderPositionId) && fromProviderPositionId > 0) {
        return fromProviderPositionId
    }

    const fromMetadata = Number(position.metadata?.ticket)
    if (Number.isInteger(fromMetadata) && fromMetadata > 0) {
        return fromMetadata
    }

    return undefined
}

function resolveMT5InstrumentClass(symbol: string): ExecutionCostSnapshot["instrumentClass"] {
    if (symbol === "XAUUSD") {
        return "metal"
    }

    if (symbol === "US30") {
        return "index"
    }

    return "fx"
}

function resolveMT5VerificationPrice(
    intent: OrderIntent,
    symbolInfo?: MT5SymbolInfo
): number | undefined {
    if (typeof intent.limitPrice === "number") {
        return intent.limitPrice
    }

    if (typeof intent.stopPrice === "number") {
        return intent.stopPrice
    }

    const estimatedPrice = intent.metadata?.estimatedPrice
    if (typeof estimatedPrice === "number") {
        return estimatedPrice
    }

    if (symbolInfo) {
        return intent.side === "buy" ? symbolInfo.ask : symbolInfo.bid
    }

    return undefined
}

function resolveMT5ComparisonPrice(
    intent: OrderIntent,
    symbolInfo: MT5SymbolInfo
): number {
    if (intent.orderType === "market") {
        return intent.side === "buy" ? symbolInfo.ask : symbolInfo.bid
    }

    return (symbolInfo.bid + symbolInfo.ask) / 2
}

function mapMT5WorkingOrder(raw: MT5OpenOrder, observedAt: number = Date.now()): WorkingOrder {
    const quantity = raw.volumeInitial
    const remainingQuantity = raw.volumeCurrent
    const filledQuantity = Math.max(quantity - remainingQuantity, 0)
    const submittedAt = normalizeMT5ProviderTimestamp(raw.timeSetup, observedAt) ?? observedAt
    const updatedAt = normalizeMT5ProviderTimestamp(raw.timeDone || raw.timeSetup, observedAt) ?? submittedAt

    return {
        orderId: String(raw.ticket),
        instrument: raw.symbol,
        status: mapMT5OrderState(raw.state),
        quantity,
        filledQuantity,
        remainingQuantity,
        submittedAt,
        updatedAt,
        side: raw.type.startsWith("buy") ? "buy" : "sell",
        limitPrice: raw.priceOpen > 0 ? raw.priceOpen : undefined,
        stopPrice: raw.stopLoss > 0 ? raw.stopLoss : undefined,
        metadata: {
            takeProfit: raw.takeProfit > 0 ? raw.takeProfit : undefined,
            comment: raw.comment,
            magic: raw.magic,
            type: raw.type,
        },
    }
}

function normalizeMT5ProviderTimestamp(
    timestamp: number | undefined,
    observedAt: number
): number | undefined {
    if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) {
        return undefined
    }

    return timestamp > observedAt + MT5_PROVIDER_FUTURE_SKEW_MS
        ? observedAt
        : timestamp
}

function mapMT5SubmissionResult(
    client: MT5Client,
    result: MT5OrderResult,
    intent: OrderIntent
): ExecutionResult {
    if (intent.orderType === "market") {
        return client.mapOrderResultToExecution(result)
    }

    const execution = client.mapOrderResultToExecution(result, {
        successStatus: "pending",
        filledQuantity: 0,
    })

    return {
        ...execution,
        fillPrice: undefined,
    }
}

function resolveMT5FilledQuantity(
    status: {
        volume: number
        volumeInitial?: number
    },
    mappedStatus: ExecutionResult["status"]
): number {
    if (mappedStatus !== "filled" && mappedStatus !== "partially_filled") {
        return 0
    }

    const remainingVolume = Math.max(status.volume, 0)
    const initialVolume = status.volumeInitial === undefined
        ? undefined
        : Math.max(status.volumeInitial, 0)

    if (initialVolume !== undefined) {
        const inferredFill = initialVolume - remainingVolume
        if (inferredFill > 0) {
            return inferredFill
        }
        if (mappedStatus === "filled" && initialVolume > 0 && remainingVolume === 0) {
            return initialVolume
        }
        if (mappedStatus === "filled" && initialVolume === 0 && remainingVolume > 0) {
            return remainingVolume
        }
        return 0
    }

    return remainingVolume
}

function aggregateMT5CloseResults(
    instrument: string,
    results: ExecutionResult[]
): ExecutionResult {
    if (results.length === 1) {
        return results[0]!
    }

    const filledResults = results.filter((result) => result.status === "filled")
    const filledQuantity = filledResults.reduce((total, result) => total + result.filledQuantity, 0)
    const fillValue = filledResults.reduce(
        (total, result) => total + result.filledQuantity * (result.fillPrice ?? 0),
        0
    )
    const failedResults = results.filter((result) => result.status !== "filled")
    const status: ExecutionResult["status"] = failedResults.length === 0
        ? "filled"
        : filledResults.length > 0
            ? "partially_filled"
            : "rejected"
    const errorDetail = failedResults.length > 0
        ? createExecutionErrorDetail("venue", `Failed to close every MT5 ${instrument} position`, {
            code: "MT5_BULK_CLOSE_INCOMPLETE",
            retryable: false,
            details: {
                results,
            },
        })
        : undefined

    return {
        orderId: results.map((result) => result.orderId).filter(Boolean).join(","),
        status,
        filledQuantity,
        fillPrice: filledQuantity > 0 ? fillValue / filledQuantity : undefined,
        timestamp: Date.now(),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
    }
}

function mapMT5PositionClosure(raw: MT5PositionClosure, observedAt: number = Date.now()): ProviderPositionClosure {
    return {
        instrument: raw.symbol,
        providerPositionId: String(raw.positionId),
        side: raw.side,
        quantity: raw.volume,
        fillPrice: raw.price,
        closedAt: normalizeMT5ProviderTimestamp(raw.timeDone, observedAt) ?? observedAt,
        metadata: {
            ticket: raw.ticket,
            orderId: raw.orderId,
            positionId: raw.positionId,
            profit: raw.profit,
            entry: raw.entry,
            reason: raw.reason,
        },
    }
}

function mapMT5OrderState(
    state: string
): "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out" {
    switch (state) {
        case "filled":
            return "filled"
        case "partial":
            return "partially_filled"
        case "canceled":
        case "cancelled":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
            return "rejected"
        case "started":
        case "placed":
        default:
            return "pending"
    }
}
