import {
    createExecutionError,
    ExecutionCostTracker,
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
    type MT5SymbolInfo,
    type MT5WorkerCredentials,
} from "./mt5-client"
import { toMT5MarketSnapshot, type MT5MarketSnapshot } from "./market-context"
import {
    aggregateMT5CloseResults,
    buildMT5ExecutionCostSnapshot,
    mapMT5OrderState,
    mapMT5Position,
    mapMT5PositionClosure,
    mapMT5SubmissionResult,
    mapMT5WorkingOrder,
    parseMT5Ticket,
    readMT5Ticket,
    rejectInvalidMT5Ticket,
    rejectMT5PreValidation,
    resolveMT5ComparisonPrice,
    resolveMT5FilledQuantity,
    resolveMT5VerificationPrice,
} from "./venue-mappers"

export class MT5VenueAdapter implements VenueAdapter, PriceVerifier {
    private lastConnectedAt = 0
    private readonly CONNECTION_TTL = 60_000

    constructor(
        private readonly client: MT5Client,
        private readonly credentials: MT5WorkerCredentials,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

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
            dayPnl: 0,
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

        return await this.withTicket(orderId, async (ticket) => {
            const result = await this.client.cancelOrder({ ticket })
            return this.client.mapOrderResultToExecution(result, {
                fallbackOrderId: orderId,
                successStatus: "cancelled",
                filledQuantity: 0,
            })
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

        const stopLoss = changes.stopPrice ?? (changes.metadata?.stopLoss as number | undefined)
        const takeProfit = changes.limitPrice ?? (changes.metadata?.takeProfit as number | undefined)

        if (stopLoss === undefined && takeProfit === undefined) {
            return rejectMT5PreValidation({
                orderId,
                message: "Provide newStopLoss, newTakeProfit, or both",
                code: "MISSING_MODIFICATION_FIELDS",
                details: {
                    orderId,
                },
            })
        }

        return await this.withTicket(orderId, async (ticket) => {
            const result = await this.client.modifyPosition({
                ticket,
                stopLoss,
                takeProfit,
            })

            return this.client.mapOrderResultToExecution(result, {
                fallbackOrderId: orderId,
            })
        })
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        const positions = await this.client.getPositions()
        const matchingPositions = positions.filter((position) => position.symbol === instrument)

        if (matchingPositions.length === 0) {
            return rejectMT5PreValidation({
                message: `No open MT5 position found for ${instrument}`,
                code: "POSITION_NOT_FOUND",
                details: {
                    instrument,
                },
            })
        }

        const results: ExecutionResult[] = []
        for (const position of matchingPositions) {
            const result = await this.client.closePosition({ ticket: position.ticket })
            results.push(
                this.client.mapOrderResultToExecution(result, {
                    fallbackOrderId: String(position.ticket),
                })
            )
        }

        return aggregateMT5CloseResults(instrument, results)
    }

    async closeProviderPosition(position: Position): Promise<ExecutionResult> {
        await this.ensureConnected()

        const ticket = readMT5Ticket(position)
        if (ticket === undefined) {
            return rejectMT5PreValidation({
                message: `No MT5 provider ticket found for ${position.instrument}`,
                code: "POSITION_NOT_FOUND",
                details: {
                    instrument: position.instrument,
                    providerPositionId: position.providerPositionId,
                },
            })
        }

        const result = await this.client.closePosition({ ticket })
        return this.client.mapOrderResultToExecution(result, {
            fallbackOrderId: String(ticket),
        })
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        return await this.withTicket(orderId, async (ticket) => {
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
        })
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
        return buildMT5ExecutionCostSnapshot(symbolInfo)
    }

    private async withTicket(
        orderId: string,
        handler: (ticket: number) => Promise<ExecutionResult>
    ): Promise<ExecutionResult> {
        const ticket = parseMT5Ticket(orderId)
        if (ticket === undefined) {
            return rejectInvalidMT5Ticket(orderId)
        }

        return await handler(ticket)
    }
}
