import {
    createExecutionErrorDetail,
    formatExecutionError,
    type ExecutionCostSnapshot,
    type ExecutionResult,
    type OrderIntent,
    type Position,
    type ProviderPositionClosure,
    type WorkingOrder,
} from "@valiq-trading/core"
import {
    MT5Client,
    type MT5OpenOrder,
    type MT5OrderResult,
    type MT5Position,
    type MT5PositionClosure,
    type MT5SymbolInfo,
} from "./mt5-client"
import { resolveMT5NormalizedSpread } from "./market-context"

const MT5_PROVIDER_FUTURE_SKEW_MS = 60_000

export function mapMT5Position(raw: MT5Position, observedAt: number = Date.now()): Position {
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

export function readMT5Ticket(position: Position): number | undefined {
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

export function parseMT5Ticket(orderId: string): number | undefined {
    const ticket = Number(orderId)
    if (!Number.isInteger(ticket) || ticket <= 0) {
        return undefined
    }

    return ticket
}

export function rejectMT5PreValidation(params: {
    orderId?: string
    message: string
    code: string
    details?: Record<string, unknown>
}): ExecutionResult {
    const errorDetail = createExecutionErrorDetail("pre_validation", params.message, {
        code: params.code,
        retryable: false,
        details: params.details,
    })

    return {
        orderId: params.orderId ?? "",
        status: "rejected",
        filledQuantity: 0,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

export function rejectInvalidMT5Ticket(orderId: string): ExecutionResult {
    return rejectMT5PreValidation({
        orderId,
        message: "Invalid MT5 ticket number",
        code: "INVALID_ORDER_ID",
        details: {
            orderId,
        },
    })
}

export function resolveMT5VerificationPrice(
    intent: OrderIntent,
    symbolInfo?: MT5SymbolInfo
): number | undefined {
    if (isPositiveMT5Price(intent.limitPrice)) {
        return intent.limitPrice
    }

    if (isPositiveMT5Price(intent.stopPrice)) {
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

export function isPositiveMT5Price(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
}

export function resolveMT5ComparisonPrice(
    intent: OrderIntent,
    symbolInfo: MT5SymbolInfo
): number {
    if (intent.orderType === "market") {
        return intent.side === "buy" ? symbolInfo.ask : symbolInfo.bid
    }

    return (symbolInfo.bid + symbolInfo.ask) / 2
}

export function mapMT5WorkingOrder(raw: MT5OpenOrder, observedAt: number = Date.now()): WorkingOrder {
    const quantity = raw.volumeInitial
    const remainingQuantity = raw.volumeCurrent
    const filledQuantity = Math.max(quantity - remainingQuantity, 0)
    const submittedAt = normalizeMT5ProviderTimestamp(raw.timeSetup, observedAt) ?? observedAt
    const updatedAt = normalizeMT5ProviderTimestamp(raw.timeDone || raw.timeSetup, observedAt) ?? submittedAt

    return {
        orderId: String(raw.ticket),
        providerOrderId: String(raw.ticket),
        providerClientOrderId: raw.comment || undefined,
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
            providerClientOrderId: raw.comment || undefined,
            takeProfit: raw.takeProfit > 0 ? raw.takeProfit : undefined,
            comment: raw.comment,
            magic: raw.magic,
            type: raw.type,
        },
    }
}

export function mapMT5SubmissionResult(
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

export function resolveMT5FilledQuantity(
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

export function aggregateMT5CloseResults(
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
    const providerOrderIds = results
        .map((result) => result.providerOrderId ?? result.orderId)
        .filter(Boolean)
    const providerClientOrderIds = Array.from(new Set(
        results
            .map((result) => result.providerClientOrderId)
            .filter((value): value is string => Boolean(value))
    ))
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
        providerOrderId: providerOrderIds.join(",") || undefined,
        providerClientOrderId: providerClientOrderIds.length === 1 ? providerClientOrderIds[0] : undefined,
        status,
        filledQuantity,
        fillPrice: filledQuantity > 0 ? fillValue / filledQuantity : undefined,
        timestamp: Date.now(),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
    }
}

export function mapMT5PositionClosure(raw: MT5PositionClosure, observedAt: number = Date.now()): ProviderPositionClosure {
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

export function mapMT5OrderState(
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

export function buildMT5ExecutionCostSnapshot(symbolInfo: MT5SymbolInfo): ExecutionCostSnapshot {
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

function resolveMT5InstrumentClass(symbol: string): ExecutionCostSnapshot["instrumentClass"] {
    if (symbol === "XAUUSD") {
        return "metal"
    }

    if (symbol === "US30") {
        return "index"
    }

    return "fx"
}
