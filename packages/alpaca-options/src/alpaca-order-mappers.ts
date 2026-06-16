import {
    createExecutionError,
    createExecutionErrorDetail,
    formatExecutionError,
    type ExecutionResult,
    type OrderIntent,
} from "@valiq-trading/core"
import type { AlpacaOrderResponse } from "./alpaca-client-types"

function mapOrderType(orderType: OrderIntent["orderType"]): string {
    return orderType === "stop_limit" ? "stop_limit" : orderType
}

export function mapOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "filled":
            return "filled"
        case "partially_filled":
            return "partially_filled"
        case "canceled":
        case "cancelled":
        case "pending_cancel":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
        case "suspended":
            return "rejected"
        default:
            return "pending"
    }
}

export function mapOrderResponse(order: AlpacaOrderResponse): ExecutionResult {
    const status = mapOrderStatus(order.status)
    const quantity = order.qty ? Number(order.qty) : undefined
    const limitPrice = normalizeAlpacaMlegLimitPrice(
        order.limit_price ? Number(order.limit_price) : undefined,
        order
    )
    const intentUpdates: Partial<OrderIntent> = {}
    const errorDetail = status === "rejected"
        ? createExecutionErrorDetail("venue", order.status, {
            code: order.status.toUpperCase(),
            retryable: false,
            details: {
                orderId: order.id,
                providerClientOrderId: order.client_order_id,
                status: order.status,
            },
        })
        : undefined

    if (quantity !== undefined) {
        intentUpdates.quantity = quantity
    }

    if (limitPrice !== undefined) {
        intentUpdates.limitPrice = limitPrice
    }
    if (status === "filled" || status === "partially_filled") {
        intentUpdates.metadata = buildAlpacaOrderAccountingMetadata(order)
    }

    return {
        orderId: order.id,
        providerOrderId: order.id,
        providerClientOrderId: order.client_order_id,
        status,
        filledQuantity: Number(order.filled_qty ?? 0),
        fillPrice: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        timestamp: resolveOrderTimestamp(order),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
        intentUpdates: Object.keys(intentUpdates).length > 0 ? intentUpdates : undefined,
    }
}

function buildAlpacaOrderAccountingMetadata(order: AlpacaOrderResponse): Record<string, unknown> {
    return {
        providerAccountingSource: "alpaca_order",
        providerOrderId: order.id,
        providerClientOrderId: order.client_order_id,
    }
}

export function buildCreateOrderPayload(intent: OrderIntent, clientOrderId?: string): Record<string, unknown> {
    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        throw createExecutionError("pre_validation", "Alpaca options orders require a positive integer quantity", {
            code: "INVALID_QUANTITY",
            retryable: false,
        })
    }

    if (intent.orderType !== "limit") {
        throw createExecutionError("pre_validation", "Alpaca options orders only support limit pricing", {
            code: "ORDER_TYPE_UNSUPPORTED",
            retryable: false,
        })
    }

    if (intent.timeInForce !== "day") {
        throw createExecutionError("pre_validation", "Alpaca options orders only support day time in force", {
            code: "TIME_IN_FORCE_UNSUPPORTED",
            retryable: false,
        })
    }

    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        throw createExecutionError("pre_validation", "Alpaca options orders require a positive limit price", {
            code: "INVALID_LIMIT_PRICE",
            retryable: false,
        })
    }

    if (intent.stopPrice !== undefined) {
        throw createExecutionError("pre_validation", "Alpaca options orders do not support stop prices", {
            code: "STOP_PRICE_UNSUPPORTED",
            retryable: false,
        })
    }

    if (!intent.legs || (intent.legs.length !== 1 && intent.legs.length !== 2 && intent.legs.length !== 4)) {
        throw createExecutionError("pre_validation", "Alpaca options orders must be submitted as 1, 2, or 4 legs", {
            code: "INVALID_LEG_COUNT",
            retryable: false,
        })
    }

    if (intent.legs.some((leg) => !Number.isInteger(leg.quantity) || leg.quantity <= 0)) {
        throw createExecutionError("pre_validation", "Alpaca options orders require positive integer leg ratios", {
            code: "INVALID_LEG_RATIO",
            retryable: false,
        })
    }

    if (intent.legs.length === 1) {
        const leg = intent.legs[0]!
        const mappedLeg = mapAlpacaLegSide(leg.side)

        if (leg.instrument.trim().toUpperCase() !== intent.instrument.trim().toUpperCase()) {
            throw createExecutionError("pre_validation", "Alpaca single-leg option orders require intent instrument to match the leg symbol", {
                code: "INVALID_SINGLE_LEG_INSTRUMENT",
                retryable: false,
                details: {
                    instrument: intent.instrument,
                    legInstrument: leg.instrument,
                },
            })
        }

        return {
            client_order_id: clientOrderId,
            symbol: leg.instrument,
            type: mapOrderType(intent.orderType),
            time_in_force: intent.timeInForce,
            qty: intent.quantity,
            limit_price: roundPrice(Math.abs(intent.limitPrice)),
            side: mappedLeg.side,
            position_intent: mappedLeg.position_intent,
        }
    }

    return {
        client_order_id: clientOrderId,
        order_class: "mleg",
        type: mapOrderType(intent.orderType),
        time_in_force: intent.timeInForce,
        qty: intent.quantity,
        limit_price: toSignedAlpacaMlegLimitPrice(intent.limitPrice, intent.side),
        legs: intent.legs.map((leg) => ({
            symbol: leg.instrument,
            ratio_qty: leg.quantity,
            ...mapAlpacaLegSide(leg.side),
        })),
    }
}

function mapAlpacaLegSide(
    side: NonNullable<OrderIntent["legs"]>[number]["side"]
): {
    side: "buy" | "sell"
    position_intent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
} {
    switch (side) {
        case "buy_to_open":
        case "buy_to_close":
            return {
                side: "buy",
                position_intent: side,
            }
        case "sell_to_open":
        case "sell_to_close":
            return {
                side: "sell",
                position_intent: side,
            }
        default:
            throw createExecutionError("pre_validation", `Unsupported Alpaca leg side: ${String(side)}`, {
                code: "INVALID_LEG_SIDE",
                retryable: false,
            })
    }
}

export function resolveOrderTimestamp(order: AlpacaOrderResponse): number {
    const rawTimestamp = order.updated_at ?? order.submitted_at
    const parsed = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
}

export function toSignedAlpacaMlegLimitPrice(
    limitPrice: number,
    side: "buy" | "sell" | null
): number {
    const normalizedLimitPrice = roundPrice(Math.abs(limitPrice))

    if (side === "sell") {
        return -normalizedLimitPrice
    }

    if (side === "buy") {
        return normalizedLimitPrice
    }

    throw createExecutionError("pre_validation", "Could not determine Alpaca multi-leg order side for signed limit price conversion", {
        code: "ALPACA_MLEG_SIDE_UNKNOWN",
        retryable: false,
    })
}

function normalizeAlpacaMlegLimitPrice(
    limitPrice: number | undefined,
    order: Pick<AlpacaOrderResponse, "order_class" | "legs">
): number | undefined {
    if (limitPrice === undefined) {
        return undefined
    }

    if (!isAlpacaMlegOrder(order)) {
        return limitPrice
    }

    return roundPrice(Math.abs(limitPrice))
}

export function resolveAlpacaMlegOrderSide(
    order: Pick<AlpacaOrderResponse, "order_class" | "side" | "limit_price" | "legs">
): "buy" | "sell" | null {
    if (!isAlpacaMlegOrder(order)) {
        return order.side ?? null
    }

    if (order.side === "buy" || order.side === "sell") {
        return order.side
    }

    const signedLimitPrice = asOptionalNumber(order.limit_price)
    if (signedLimitPrice !== undefined && signedLimitPrice !== 0) {
        return signedLimitPrice < 0 ? "sell" : "buy"
    }

    const positionIntents = (order.legs ?? [])
        .map((leg) => leg.position_intent)
        .filter((value): value is NonNullable<typeof value> => Boolean(value))

    if (positionIntents.length === 0) {
        return null
    }

    if (positionIntents.every((positionIntent) => positionIntent.endsWith("_open"))) {
        return "sell"
    }

    if (positionIntents.every((positionIntent) => positionIntent.endsWith("_close"))) {
        return "buy"
    }

    return null
}

function isAlpacaMlegOrder(
    order: Pick<AlpacaOrderResponse, "order_class" | "legs">
): boolean {
    return order.order_class === "mleg" || Boolean(order.legs && order.legs.length > 0)
}

function roundPrice(price: number): number {
    return Math.round(price * 100) / 100
}

function asOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}
