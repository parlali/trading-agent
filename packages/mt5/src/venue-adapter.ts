import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    getExecutionErrorDetail,
    type AccountState,
    type ExecutionCostAssessment,
    type ExecutionCostSnapshot,
    type ExecutionResult,
    type OrderIntent,
    type OrderOperationContext,
    type PriceVerification,
    type PriceVerifier,
    type Position,
    type ProviderPositionClosure,
    type SubmitOrderContext,
    type SubmitRecoveryResult,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import {
    isRecoverableMT5ConnectionError,
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
    readonly identityCapability = "native_client_id" as const
    private static readonly connectionPromises = new Map<string, Promise<void>>()
    private lastConnectedAt = 0
    private readonly CONNECTION_TTL = 60_000
    private readonly CONNECT_RETRY_ATTEMPTS = 6
    private readonly CONNECT_RETRY_DELAY_MS = 1_000

    constructor(
        private readonly client: MT5Client,
        private readonly credentials: MT5WorkerCredentials,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

    async ensureConnected(): Promise<void> {
        if (Date.now() - this.lastConnectedAt < this.CONNECTION_TTL) {
            return
        }

        const key = this.client.connectionKey(this.credentials)
        const existingPromise = MT5VenueAdapter.connectionPromises.get(key)
        if (existingPromise) {
            await existingPromise
            this.lastConnectedAt = Date.now()
            return
        }

        const connectionPromise = this.establishConnection()
        MT5VenueAdapter.connectionPromises.set(key, connectionPromise)
        try {
            await connectionPromise
        } finally {
            if (MT5VenueAdapter.connectionPromises.get(key) === connectionPromise) {
                MT5VenueAdapter.connectionPromises.delete(key)
            }
        }
    }

    private async establishConnection(): Promise<void> {
        for (let attempt = 1; attempt <= this.CONNECT_RETRY_ATTEMPTS; attempt++) {
            const health = await this.client.getHealth()
            if (health.connected && health.login === this.credentials.login) {
                this.lastConnectedAt = Date.now()
                return
            }

            try {
                await this.client.connect(this.credentials)
                this.lastConnectedAt = Date.now()
                return
            } catch (error) {
                if (!isMT5ConnectContention(error) || attempt === this.CONNECT_RETRY_ATTEMPTS) {
                    throw error
                }
                await sleep(this.CONNECT_RETRY_DELAY_MS)
            }
        }
    }

    async getPositions(): Promise<Position[]> {
        return await this.withRecoverableRead(async () => {
            const observedAt = Date.now()
            const raw = await this.client.getPositions()
            return raw.map((position) => mapMT5Position(position, observedAt))
        })
    }

    async getAccountState(): Promise<AccountState> {
        return await this.withRecoverableRead(async () => {
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
        })
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        return await this.withRecoverableRead(async () => {
            const observedAt = Date.now()
            const orders = await this.client.getOpenOrders()
            return orders.map((order) => mapMT5WorkingOrder(order, observedAt))
        })
    }

    async getRecentPositionClosures(): Promise<ProviderPositionClosure[]> {
        return await this.withRecoverableRead(async () => {
            const observedAt = Date.now()
            const closures = await this.client.getPositionClosures()
            return closures.map((closure) => mapMT5PositionClosure(closure, observedAt))
        })
    }

    async submitOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        if (!context?.identity.providerClientOrderId) {
            throw createExecutionError("pre_validation", "MT5 live submission requires canonical execution identity", {
                code: "MISSING_CANONICAL_ORDER_ID",
                retryable: false,
                details: {
                    instrument: intent.instrument,
                },
            })
        }

        await this.ensureConnected()
        const providerClientOrderId = context.identity.providerClientOrderId

        const result = await this.client.submitOrder({
            symbol: intent.instrument,
            side: intent.side,
            volume: intent.quantity,
            orderType: intent.orderType,
            price: intent.limitPrice ?? intent.stopPrice,
            stopLoss: intent.metadata?.stopLoss as number | undefined,
            takeProfit: intent.metadata?.takeProfit as number | undefined,
            magic: (intent.metadata?.magic as number) ?? 0,
            comment: providerClientOrderId,
        })

        return {
            ...mapMT5SubmissionResult(this.client, result, intent),
            providerClientOrderId,
            providerOrderId: result.orderId || result.dealId || undefined,
        }
    }

    classifySubmitError(error: unknown): "commit_unknown" | "rejected" | undefined {
        const detail = getExecutionErrorDetail(error)
        const text = `${detail?.message ?? ""} ${detail?.code ?? ""}`.toLowerCase()
        if (
            text.includes("ipc recv failed") ||
            text.includes("socket close") ||
            text.includes("socket closed") ||
            text.includes("timeout") ||
            text.includes("timed out")
        ) {
            return "commit_unknown"
        }

        return detail?.retryable ? "commit_unknown" : "rejected"
    }

    async recoverSubmittedOrder(
        _intent: OrderIntent,
        context: SubmitOrderContext,
        _error?: unknown
    ): Promise<SubmitRecoveryResult> {
        await sleep(250)
        return await this.withRecoverableRead(async () => {
            const providerClientOrderId = context.identity.providerClientOrderId
            const orders = await this.client.getOpenOrders()
            const matches = orders.filter((order) => order.comment === providerClientOrderId)

            if (matches.length > 1) {
                return {
                    outcome: "ambiguous",
                    message: "MT5 commit-unknown recovery found multiple live orders with the canonical client id",
                    matches: matches.map((order) => ({
                        orderId: String(order.ticket),
                        providerOrderId: String(order.ticket),
                        providerClientOrderId,
                        status: mapMT5OrderState(order.state),
                        filledQuantity: 0,
                        timestamp: Date.now(),
                    })),
                    details: {
                        providerClientOrderId,
                        tickets: matches.map((order) => order.ticket),
                    },
                }
            }

            if (matches.length === 1) {
                const match = matches[0]!
                return {
                    outcome: "accepted",
                    result: {
                        orderId: String(match.ticket),
                        providerOrderId: String(match.ticket),
                        providerClientOrderId,
                        status: mapMT5OrderState(match.state),
                        filledQuantity: 0,
                        timestamp: Date.now(),
                        commitOutcome: "recovered",
                    },
                }
            }

            const positions = await this.client.getPositions()
            const positionMatches = positions.filter((position) =>
                position.comment === providerClientOrderId
            )

            if (positionMatches.length === 1) {
                const match = positionMatches[0]!
                return {
                    outcome: "accepted",
                    result: {
                        orderId: String(match.ticket),
                        providerOrderId: String(match.ticket),
                        providerClientOrderId,
                        status: "filled",
                        filledQuantity: match.volume,
                        fillPrice: match.openPrice > 0 ? match.openPrice : undefined,
                        timestamp: Date.now(),
                        commitOutcome: "recovered",
                    },
                }
            }

            if (positionMatches.length > 1) {
                return {
                    outcome: "ambiguous",
                    message: "MT5 commit-unknown recovery found multiple live positions with the canonical client id",
                    matches: positionMatches.map((position) => ({
                        orderId: String(position.ticket),
                        providerOrderId: String(position.ticket),
                        providerClientOrderId,
                        status: "filled",
                        filledQuantity: position.volume,
                        fillPrice: position.openPrice > 0 ? position.openPrice : undefined,
                        timestamp: Date.now(),
                    })),
                    details: {
                        providerClientOrderId,
                        tickets: positionMatches.map((position) => position.ticket),
                    },
                }
            }

            return {
                outcome: "not_found",
                message: "MT5 commit-unknown recovery found no live order or position with the canonical client id",
                details: {
                    providerClientOrderId,
                },
            }
        })
    }

    async cancelOrder(orderId: string, context?: OrderOperationContext): Promise<ExecutionResult> {
        await this.ensureConnected()

        const ticketIds = uniqueTickets([
            orderId,
            context?.canonicalOrderId,
            context?.providerOrderId,
            context?.providerClientOrderId,
            ...(context?.providerOrderAliases ?? []),
        ])

        if (ticketIds.length === 0) {
            return rejectInvalidMT5Ticket(orderId)
        }

        const results: ExecutionResult[] = []
        for (const ticket of ticketIds) {
            const result = await this.client.cancelOrder({ ticket })
            results.push(this.client.mapOrderResultToExecution(result, {
                fallbackOrderId: String(ticket),
                successStatus: "cancelled",
                filledQuantity: 0,
            }))
        }

        return aggregateMT5CancelResults(orderId, results)
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

    async closePosition(
        instrument: string,
        _preparedIntent?: OrderIntent,
        context?: SubmitOrderContext
    ): Promise<ExecutionResult> {
        const providerClientOrderId = requireMT5CloseProviderClientOrderId(context, instrument)
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
            const result = await this.client.closePosition({
                ticket: position.ticket,
                comment: providerClientOrderId,
            })
            results.push(
                {
                    ...this.client.mapOrderResultToExecution(result, {
                        fallbackOrderId: String(position.ticket),
                    }),
                    providerClientOrderId,
                }
            )
        }

        return aggregateMT5CloseResults(instrument, results)
    }

    async closeProviderPosition(
        position: Position,
        _preparedIntent?: OrderIntent,
        context?: SubmitOrderContext
    ): Promise<ExecutionResult> {
        const providerClientOrderId = requireMT5CloseProviderClientOrderId(context, position.instrument)
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

        const result = await this.client.closePosition({
            ticket,
            comment: providerClientOrderId,
        })
        return {
            ...this.client.mapOrderResultToExecution(result, {
                fallbackOrderId: String(ticket),
            }),
            providerClientOrderId,
        }
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        return await this.withRecoverableRead(async () =>
            await this.withTicket(orderId, async (ticket) => {
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
        )
    }

    async getSymbolInfo(symbol: string): Promise<MT5SymbolInfo | null> {
        return await this.withRecoverableRead(async () => {
            const results = await this.client.getSymbolInfo([symbol])
            return results.length > 0 ? (results[0] ?? null) : null
        })
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

        return await this.withRecoverableRead(async () => {
            const results = await this.client.getSymbolInfo(symbols)
            return await Promise.all(
                results.map(async (symbolInfo) => toMT5MarketSnapshot(
                    symbolInfo,
                    await this.assessSymbolExecutionCost(symbolInfo)
                ))
            )
        })
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

    private async withRecoverableRead<T>(read: () => Promise<T>): Promise<T> {
        await this.ensureConnected()
        try {
            return await read()
        } catch (error) {
            if (!isRecoverableMT5ConnectionError(error)) {
                throw error
            }

            this.lastConnectedAt = 0
            await this.ensureConnected()
            return await read()
        }
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

export function isMT5ConnectContention(error: unknown): boolean {
    const detail = getExecutionErrorDetail(error)
    return detail?.retryable === true && detail.code === "connect_in_progress"
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function aggregateMT5CancelResults(orderId: string, results: ExecutionResult[]): ExecutionResult {
    const failed = results.filter((result) => result.status !== "cancelled")
    const errorDetail = failed.length > 0
        ? createExecutionErrorDetail(
            "venue",
            "Failed to cancel every MT5 provider ticket owned by the canonical request",
            {
                code: "MT5_CANONICAL_CANCEL_RESIDUAL_TICKETS",
                retryable: true,
                details: {
                    failedTickets: failed.map((result) => result.providerOrderId ?? result.orderId),
                    cancelledTickets: results
                        .filter((result) => result.status === "cancelled")
                        .map((result) => result.providerOrderId ?? result.orderId),
                },
            }
        )
        : undefined
    return {
        orderId: results.map((result) => result.orderId).filter(Boolean).join(",") || orderId,
        providerOrderId: results.map((result) => result.providerOrderId ?? result.orderId).filter(Boolean).join(","),
        providerOrderAliases: results.map((result) => result.orderId).filter((value) => value !== orderId),
        status: failed.length === 0 ? "cancelled" : "rejected",
        filledQuantity: 0,
        timestamp: Date.now(),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
    }
}

function uniqueTickets(values: Array<string | undefined>): number[] {
    const tickets = new Set<number>()

    for (const value of values) {
        if (!value) {
            continue
        }

        const ticket = parseMT5Ticket(value)
        if (ticket !== undefined) {
            tickets.add(ticket)
        }
    }

    return Array.from(tickets)
}

function requireMT5CloseProviderClientOrderId(
    context: SubmitOrderContext | undefined,
    instrument: string
): string {
    if (!context?.identity.providerClientOrderId) {
        throw createExecutionError("pre_validation", "MT5 close requires canonical execution identity", {
            code: "MISSING_CANONICAL_ORDER_ID",
            retryable: false,
            details: {
                instrument,
            },
        })
    }

    return context.identity.providerClientOrderId
}
