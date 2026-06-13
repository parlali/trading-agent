import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    getExecutionErrorDetail,
    mergeIdentityAliases,
    type AccountState,
    type AccountPnlEvent,
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
    type MT5AccountPnlEvent,
    type MT5PositionClosure,
    type MT5SymbolInfo,
    type MT5WorkerCredentials,
} from "./mt5-client"
import { toMT5MarketSnapshot, type MT5MarketSnapshot } from "./market-context"
import {
    aggregateMT5CloseResults,
    aggregateMT5FilledStats,
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
    isPositiveMT5Price,
    resolveMT5ComparisonPrice,
    resolveMT5FilledQuantity,
    resolveMT5VerificationPrice,
} from "./venue-mappers"

export class MT5VenueAdapter implements VenueAdapter, PriceVerifier {
    readonly identityCapability = "native_client_id" as const

    constructor(
        private readonly client: MT5Client,
        private readonly credentials: MT5WorkerCredentials,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

    async ensureConnected(): Promise<void> {
        const info = await this.client.getAccount(this.credentials)
        this.assertAccountIdentity(info.login)
    }

    private assertAccountIdentity(reportedLogin: number): void {
        if (reportedLogin !== this.credentials.login) {
            throw createExecutionError(
                "venue",
                `MT5 worker served account ${reportedLogin} but this adapter is bound to login ${this.credentials.login}`,
                {
                    code: "session_login_mismatch",
                    retryable: false,
                    details: {
                        expectedLogin: this.credentials.login,
                        reportedLogin,
                        server: this.credentials.server,
                    },
                }
            )
        }
    }

    async getPositions(): Promise<Position[]> {
        return await this.withRecoverableRead(async () => {
            const observedAt = Date.now()
            const raw = await this.client.getPositions(this.credentials)
            return raw.map((position) => mapMT5Position(position, observedAt))
        })
    }

    async getAccountState(): Promise<AccountState> {
        return await this.withRecoverableRead(async () => {
            const info = await this.client.getAccount(this.credentials)
            this.assertAccountIdentity(info.login)
            assertMT5AccountCurrency(info.currency)
            const [closures, accountPnlEvents] = await Promise.all([
                this.client.getPositionClosures(this.credentials, 24),
                this.client.getAccountPnlEvents(this.credentials, 24),
            ])
            for (const event of accountPnlEvents) {
                assertMT5AccountCurrency(event.currency)
            }

            return {
                balance: info.balance,
                equity: info.equity,
                buyingPower: info.freeMargin,
                marginUsed: info.margin,
                marginAvailable: info.freeMargin,
                openPnl: info.profit,
                dayPnl: resolveMT5DayPnl(info.profit, closures, accountPnlEvents),
            }
        })
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        return await this.withRecoverableRead(async () => {
            const observedAt = Date.now()
            const orders = await this.client.getOpenOrders(this.credentials)
            return orders.map((order) => mapMT5WorkingOrder(order, observedAt))
        })
    }

    async getRecentPositionClosures(): Promise<ProviderPositionClosure[]> {
        return await this.withRecoverableRead(async () => {
            const observedAt = Date.now()
            const closures = await this.client.getPositionClosures(this.credentials)
            return closures.map((closure) => mapMT5PositionClosure(closure, observedAt))
        })
    }

    async getAccountPnlEvents(): Promise<AccountPnlEvent[]> {
        return await this.withRecoverableRead(async () => {
            const events = await this.client.getAccountPnlEvents(this.credentials)
            for (const event of events) {
                assertMT5AccountCurrency(event.currency)
            }
            return events.map((event) => ({
                providerEventId: event.providerEventId,
                eventType: event.eventType,
                instrument: event.instrument,
                amount: event.amount,
                currency: event.currency,
                occurredAt: event.occurredAt,
                metadata: event.metadata,
            }))
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

        const providerClientOrderId = context.identity.providerClientOrderId

        const result = await this.client.submitOrder(this.credentials, {
            symbol: intent.instrument,
            side: intent.side,
            volume: intent.quantity,
            orderType: intent.orderType,
            price: resolveMT5MutationPrice(intent),
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
        const rawMessage = error instanceof Error ? error.message : String(error)
        const text = `${detail?.message ?? ""} ${detail?.code ?? ""} ${rawMessage}`.toLowerCase()
        if (
            text.includes("ipc recv failed") ||
            text.includes("ipc send failed") ||
            text.includes("socket close") ||
            text.includes("socket closed") ||
            text.includes("socket connection was closed") ||
            text.includes("connection was closed unexpectedly") ||
            text.includes("connection reset") ||
            text.includes("econnreset") ||
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
            const orders = await this.client.getOpenOrders(this.credentials)
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

            const positions = await this.client.getPositions(this.credentials)
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
            const result = await this.client.cancelOrder(this.credentials, { ticket })
            const mappedResult = this.client.mapOrderResultToExecution(result, {
                fallbackOrderId: String(ticket),
                successStatus: "cancelled",
                filledQuantity: 0,
            })
            results.push(
                mappedResult.status === "cancelled"
                    ? mappedResult
                    : await this.reconcileFailedCancel(ticket, mappedResult)
            )
        }

        return aggregateMT5CancelResults(orderId, results)
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        const price = isPositiveMT5Price(changes.limitPrice)
            ? changes.limitPrice
            : isPositiveMT5Price(changes.stopPrice)
                ? changes.stopPrice
                : undefined
        const stopLoss = changes.metadata?.stopLoss as number | undefined
        const takeProfit = changes.metadata?.takeProfit as number | undefined

        if (price === undefined && stopLoss === undefined && takeProfit === undefined) {
            return rejectMT5PreValidation({
                orderId,
                message: "Provide a new price, newStopLoss, newTakeProfit, or any combination",
                code: "MISSING_MODIFICATION_FIELDS",
                details: {
                    orderId,
                },
            })
        }

        return await this.withTicket(orderId, async (ticket) => {
            const result = await this.client.modifyOrder(this.credentials, {
                ticket,
                price,
                stopLoss,
                takeProfit,
            })

            return this.client.mapOrderResultToExecution(result, {
                fallbackOrderId: orderId,
                successStatus: "pending",
                filledQuantity: 0,
                successRetcodes: [10025],
            })
        })
    }

    async closePosition(
        instrument: string,
        preparedIntent?: OrderIntent,
        context?: SubmitOrderContext
    ): Promise<ExecutionResult> {
        const providerClientOrderId = requireMT5CloseProviderClientOrderId(context, instrument)
        const ticket = readMT5CloseTicket(preparedIntent)
        if (ticket === undefined) {
            return rejectMT5PreValidation({
                message: `MT5 close for ${instrument} requires provider position identity`,
                code: "MISSING_PROVIDER_POSITION_ID",
                details: {
                    instrument,
                },
            })
        }

        const positions = await this.client.getPositions(this.credentials)
        const matchingPositions = positions.filter((position) => position.symbol === instrument && position.ticket === ticket)

        if (matchingPositions.length === 0) {
            return rejectMT5PreValidation({
                message: `No open MT5 position found for ${instrument} ticket ${ticket}`,
                code: "POSITION_NOT_FOUND",
                details: {
                    instrument,
                    ticket,
                },
            })
        }

        const results: ExecutionResult[] = []
        for (const position of matchingPositions) {
            const result = await this.client.closePosition(this.credentials, {
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

        const result = await this.client.closePosition(this.credentials, {
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
                const status = await this.client.getOrderStatus(this.credentials, ticket)
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
                    intentUpdates: buildMT5OrderStatusAccountingMetadata(status, normalizedStatus),
                }
            })
        )
    }

    async getSymbolInfo(symbol: string): Promise<MT5SymbolInfo | null> {
        return await this.withRecoverableRead(async () => {
            const results = await this.client.getSymbolInfo(this.credentials, [symbol])
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
            const results = await this.client.getSymbolInfo(this.credentials, symbols)
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
        try {
            return await read()
        } catch (error) {
            if (!isRecoverableMT5ConnectionError(error)) {
                throw error
            }

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

    private async reconcileFailedCancel(
        ticket: number,
        cancelResult: ExecutionResult
    ): Promise<ExecutionResult> {
        try {
            const status = await this.getOrderStatus(String(ticket))
            return status.status === "pending" || status.status === "partially_filled"
                ? {
                    ...cancelResult,
                    providerOrderId: cancelResult.providerOrderId ?? String(ticket),
                    providerOrderAliases: mergeIdentityAliases([
                        ...(cancelResult.providerOrderAliases ?? []),
                        status.orderId,
                        status.providerOrderId,
                    ]),
                    errorDetail: mergeCancelStatusEvidence(cancelResult, status),
                    error: cancelResult.error,
                }
                : {
                    ...status,
                    providerOrderId: status.providerOrderId ?? String(ticket),
                    providerOrderAliases: mergeIdentityAliases([
                        ...(cancelResult.providerOrderAliases ?? []),
                        cancelResult.orderId,
                        cancelResult.providerOrderId,
                    ]),
                    errorDetail: undefined,
                    error: undefined,
                }
        } catch {
            return cancelResult
        }
    }
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function assertMT5AccountCurrency(currency: string | undefined): void {
    const normalized = currency?.trim().toUpperCase()
    if (normalized === "USD") {
        return
    }

    throw createExecutionError("venue", `MT5 account currency ${currency ?? "<missing>"} is unsupported; accounting is denominated in USD`, {
        code: "MT5_ACCOUNT_CURRENCY_UNSUPPORTED",
        retryable: false,
        details: {
            currency,
            expectedCurrency: "USD",
        },
    })
}

function resolveMT5DayPnl(
    openPnl: number,
    closures: MT5PositionClosure[],
    accountPnlEvents: MT5AccountPnlEvent[]
): number {
    return openPnl
        + closures.reduce((total, closure) => total + resolveMT5ClosurePnl(closure), 0)
        + accountPnlEvents.reduce((total, event) => total + event.amount, 0)
}

function resolveMT5ClosurePnl(closure: MT5PositionClosure): number {
    return closure.profit
        + finiteOrZero(closure.swap)
        + finiteOrZero(closure.commission)
        + finiteOrZero(closure.fee)
}

function finiteOrZero(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function readMT5CloseTicket(intent: OrderIntent | undefined): number | undefined {
    const metadata = intent?.metadata
    return readMT5MetadataTicket(metadata?.providerPositionId) ?? readMT5MetadataTicket(metadata?.ticket)
}

function readMT5MetadataTicket(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value
    }
    if (typeof value === "string") {
        return parseMT5Ticket(value)
    }
    return undefined
}

function buildMT5OrderStatusAccountingMetadata(
    status: {
        ticket: number
        profit?: number
        commission?: number
        swap?: number
        fee?: number
    },
    orderStatus: ExecutionResult["status"]
): ExecutionResult["intentUpdates"] | undefined {
    if (orderStatus !== "filled" && orderStatus !== "partially_filled") {
        return undefined
    }

    const metadata: Record<string, unknown> = {
        providerAccountingSource: "mt5_deal_status",
        providerOrderId: String(status.ticket),
    }
    const hasAccounting = [
        appendFiniteMetadataNumber(metadata, "fillPnl", status.profit),
        appendFiniteMetadataNumber(metadata, "commission", status.commission),
        appendFiniteMetadataNumber(metadata, "swap", status.swap),
        appendFiniteMetadataNumber(metadata, "fee", status.fee),
    ].some(Boolean)

    if (!hasAccounting) {
        metadata.providerAccountingMissing = true
        metadata.providerAccountingMissingReason = "mt5_order_status_without_deal_accounting"
    }

    return { metadata }
}

function appendFiniteMetadataNumber(
    metadata: Record<string, unknown>,
    key: string,
    value: number | undefined
): boolean {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return false
    }

    metadata[key] = value
    return true
}

function aggregateMT5CancelResults(orderId: string, results: ExecutionResult[]): ExecutionResult {
    const unresolved = results.filter((result) => result.status !== "cancelled" && result.errorDetail !== undefined)
    const { filledQuantity, avgFillPrice } = aggregateMT5FilledStats(results)
    const terminalResult = results.find((result) => result.status !== "cancelled" && result.errorDetail === undefined)
    const errorDetail = unresolved.length > 0
        ? createExecutionErrorDetail(
            "venue",
            "Failed to cancel every MT5 provider ticket owned by the canonical request",
            {
                code: "MT5_CANONICAL_CANCEL_RESIDUAL_TICKETS",
                retryable: true,
                details: {
                    failedTickets: unresolved.map((result) => result.providerOrderId ?? result.orderId),
                    cancelledTickets: results
                        .filter((result) => result.status === "cancelled")
                        .map((result) => result.providerOrderId ?? result.orderId),
                    failedResults: unresolved.map(toMT5CancelEvidence),
                    cancelledResults: results
                        .filter((result) => result.status === "cancelled")
                        .map(toMT5CancelEvidence),
                },
            }
        )
        : undefined
    return {
        orderId: results.map((result) => result.orderId).filter(Boolean).join(",") || orderId,
        providerOrderId: results.map((result) => result.providerOrderId ?? result.orderId).filter(Boolean).join(","),
        providerOrderAliases: results.map((result) => result.orderId).filter((value) => value !== orderId),
        status: unresolved.length > 0 ? "rejected" : terminalResult?.status ?? "cancelled",
        filledQuantity,
        fillPrice: avgFillPrice ?? terminalResult?.fillPrice,
        timestamp: Date.now(),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
    }
}

function resolveMT5MutationPrice(intent: OrderIntent): number | undefined {
    if (isPositiveMT5Price(intent.limitPrice)) {
        return intent.limitPrice
    }

    return isPositiveMT5Price(intent.stopPrice) ? intent.stopPrice : undefined
}

function mergeCancelStatusEvidence(
    cancelResult: ExecutionResult,
    status: ExecutionResult
) {
    const detail = cancelResult.errorDetail
    if (!detail) {
        return undefined
    }

    return {
        ...detail,
        details: {
            ...detail.details,
            providerStatusAfterFailedCancel: toMT5CancelEvidence(status),
        },
    }
}

function toMT5CancelEvidence(result: ExecutionResult): Record<string, unknown> {
    return {
        orderId: result.orderId,
        providerOrderId: result.providerOrderId,
        providerClientOrderId: result.providerClientOrderId,
        providerOrderAliases: result.providerOrderAliases,
        status: result.status,
        filledQuantity: result.filledQuantity,
        fillPrice: result.fillPrice,
        error: result.error,
        errorDetail: result.errorDetail,
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
