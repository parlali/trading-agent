import {
    createExecutionError,
    type AccountPnlEvent,
    type PriceVerification,
    type ProviderPositionClosure,
    type WorkingOrder,
} from "@valiq-trading/core"
import { AlpacaClient, type AlpacaAccountActivity } from "./alpaca-client"
import {
    mapOrderStatus as mapAlpacaOrderStatus,
    resolveOrderTimestamp,
} from "./alpaca-order-mappers"
import {
    buildAlpacaStructureInstrumentFromLegs,
    type AlpacaStructureType,
    type AlpacaVerticalSpreadType,
    parseOptionContractSymbol,
} from "./risk-rules"
import { roundPrice, toNumber } from "./alpaca-position-structures"

export const ALPACA_OPTION_CLOSURE_ACTIVITY_TYPES = ["OPEXP", "OPEXC", "OPASN"] as const
export const ALPACA_ACCOUNT_PNL_ACTIVITY_TYPES = ["FEE"] as const

export {
    buildGroupCloseIntent,
    isAlpacaOptionPosition,
    mapSinglePosition,
    resolveGroupForClose,
    roundPrice,
    toNumber,
    type PositionGroup,
} from "./alpaca-position-structures"

type ParsedOptionContract = NonNullable<ReturnType<typeof parseOptionContractSymbol>>

export function mapWorkingOrder(order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]): WorkingOrder {
    const submittedAt = resolveOrderTimestamp(order)
    const quantity = order.qty ? Number(order.qty) : 0
    const filledQuantity = Number(order.filled_qty ?? 0)

    return {
        orderId: order.id,
        providerOrderId: order.id,
        providerClientOrderId: order.client_order_id,
        instrument: resolveOrderInstrument(order),
        status: mapAlpacaOrderStatus(order.status),
        quantity,
        filledQuantity,
        remainingQuantity: Math.max(quantity - filledQuantity, 0),
        submittedAt,
        updatedAt: submittedAt,
        side: order.side === "buy" || order.side === "sell" ? order.side : undefined,
        limitPrice: order.limit_price ? roundPrice(Math.abs(Number(order.limit_price))) : undefined,
        stopPrice: order.stop_price ? Number(order.stop_price) : undefined,
        avgFillPrice: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        metadata: {
            providerClientOrderId: order.client_order_id,
            legs: order.legs,
            ...(filledQuantity > 0 ? {
                providerAccountingSource: "alpaca_order",
                providerAccountingMissing: true,
                providerAccountingMissingReason: "alpaca_working_order_fill_requires_account_activity_fee_reconciliation",
                providerOrderId: order.id,
            } : {}),
        },
    }
}

export function mapAlpacaOptionActivityClosure(
    activity: AlpacaAccountActivity
): ProviderPositionClosure | undefined {
    const activityType = activity.activity_type.trim().toUpperCase()
    if (!isAlpacaOptionClosureActivityType(activityType)) {
        return undefined
    }
    if (activity.status && activity.status.trim().toLowerCase() !== "executed") {
        return undefined
    }

    const symbol = activity.symbol?.trim().toUpperCase()
    if (!symbol || !parseOptionContractSymbol(symbol)) {
        return undefined
    }

    const signedQuantity = toNumber(activity.qty)
    if (!Number.isFinite(signedQuantity) || signedQuantity === 0) {
        return undefined
    }

    const netAmount = toNumber(activity.net_amount)
    const price = toNumber(activity.price)

    return {
        instrument: symbol,
        providerPositionId: symbol,
        side: signedQuantity < 0 ? "long" : "short",
        quantity: Math.abs(signedQuantity),
        fillPrice: Number.isFinite(price) && price > 0 ? Math.abs(price) : 0,
        closedAt: readAlpacaActivityTime(activity),
        metadata: {
            providerAccountingSource: "alpaca_account_activity",
            providerActivityId: activity.id,
            activityType,
            description: activity.description,
            status: activity.status,
            netAmount,
            fillPnl: netAmount,
            symbol,
            qty: activity.qty,
            price: activity.price,
            providerPositionId: symbol,
        },
    }
}

export function mapAlpacaAccountPnlEvent(
    activity: AlpacaAccountActivity
): AccountPnlEvent | undefined {
    const activityType = activity.activity_type.trim().toUpperCase()
    if (!isAlpacaAccountPnlActivityType(activityType)) {
        return undefined
    }
    if (activity.status && activity.status.trim().toLowerCase() !== "executed") {
        return undefined
    }

    const amount = toNumber(activity.net_amount)
    if (!Number.isFinite(amount) || amount === 0) {
        return undefined
    }

    return {
        providerEventId: `alpaca-activity:${activity.id}`,
        eventType: "fee",
        instrument: activity.symbol?.trim().toUpperCase() || undefined,
        amount,
        currency: "USD",
        occurredAt: readAlpacaActivityTime(activity),
        metadata: {
            providerAccountingSource: "alpaca_account_activity",
            providerActivityId: activity.id,
            activityType,
            description: activity.description,
            status: activity.status,
            netAmount: amount,
            symbol: activity.symbol,
        },
    }
}

function isAlpacaOptionClosureActivityType(
    activityType: string
): activityType is typeof ALPACA_OPTION_CLOSURE_ACTIVITY_TYPES[number] {
    return ALPACA_OPTION_CLOSURE_ACTIVITY_TYPES.includes(activityType as typeof ALPACA_OPTION_CLOSURE_ACTIVITY_TYPES[number])
}

function isAlpacaAccountPnlActivityType(
    activityType: string
): activityType is typeof ALPACA_ACCOUNT_PNL_ACTIVITY_TYPES[number] {
    return ALPACA_ACCOUNT_PNL_ACTIVITY_TYPES.includes(activityType as typeof ALPACA_ACCOUNT_PNL_ACTIVITY_TYPES[number])
}

function readAlpacaActivityTime(activity: AlpacaAccountActivity): number {
    const raw = activity.transaction_time ?? activity.date
    const timestamp = raw ? Date.parse(raw) : NaN
    if (!Number.isFinite(timestamp)) {
        throw new Error(`Alpaca account activity ${activity.id} has no valid activity timestamp`)
    }
    return timestamp
}

function resolveOrderInstrument(
    order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]
): string {
    if (!order.legs || order.legs.length === 0) {
        const symbol = order.symbol?.trim().toUpperCase()
        if (symbol && parseOptionContractSymbol(symbol)) {
            return symbol
        }

        throw createExecutionError("venue", `Alpaca working order ${order.id} has no legs or option symbol`, {
            code: "ALPACA_WORKING_ORDER_INSTRUMENT_MISSING",
            retryable: false,
            details: {
                orderId: order.id,
                symbol: order.symbol,
                orderClass: order.order_class,
            },
        })
    }

    const structure = resolveStructureFromOrderLegs(order.legs)
    if (structure) {
        return buildAlpacaStructureInstrumentFromLegs(structure)
    }

    return order.legs.map((leg) => leg.symbol).join(" | ")
}

function resolveStructureFromOrderLegs(
    legs: NonNullable<Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]["legs"]>
): {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    legs: Array<{ instrument: string }>
} | null {
    if (legs.length !== 2 && legs.length !== 4) {
        return null
    }

    const normalized = legs
        .map((leg) => {
            const parsed = parseOptionContractSymbol(leg.symbol)
            const exposure = resolveOrderLegExposure(leg)
            return parsed && exposure
                ? {
                    symbol: leg.symbol,
                    parsed,
                    exposure,
                }
                : null
        })
        .filter((entry): entry is {
            symbol: string
            parsed: ParsedOptionContract
            exposure: "long" | "short"
        } => Boolean(entry))

    if (normalized.length !== legs.length) {
        return null
    }

    const underlying = normalized[0]?.parsed.underlying
    const expiration = normalized[0]?.parsed.expiration
    const sharedContract = normalized.every((leg) =>
        leg.parsed.underlying === underlying && leg.parsed.expiration === expiration
    )
    if (!underlying || !expiration || !sharedContract) {
        return null
    }

    if (normalized.length === 4) {
        const calls = normalized.filter((leg) => leg.parsed.optionType === "call")
        const puts = normalized.filter((leg) => leg.parsed.optionType === "put")
        if (calls.length !== 2 || puts.length !== 2) {
            return null
        }

        const shortCall = calls.find((leg) => leg.exposure === "short")
        const longCall = calls.find((leg) => leg.exposure === "long")
        const shortPut = puts.find((leg) => leg.exposure === "short")
        const longPut = puts.find((leg) => leg.exposure === "long")
        if (!shortCall || !longCall || !shortPut || !longPut) {
            return null
        }

        const validGeometry = (
            longPut.parsed.strike < shortPut.parsed.strike &&
            shortPut.parsed.strike < shortCall.parsed.strike &&
            shortCall.parsed.strike < longCall.parsed.strike
        )
        if (!validGeometry) {
            return null
        }

        return {
            structureType: "iron_condor",
            underlying,
            expiration,
            legs: normalized.map((leg) => ({
                instrument: leg.symbol,
            })),
        }
    }

    const shorts = normalized.filter((leg) => leg.exposure === "short")
    const longs = normalized.filter((leg) => leg.exposure === "long")
    if (shorts.length !== 1 || longs.length !== 1) {
        return null
    }

    const shortLeg = shorts[0]!
    const longLeg = longs[0]!
    if (shortLeg.parsed.optionType !== longLeg.parsed.optionType) {
        return null
    }

    if (shortLeg.parsed.optionType === "call") {
        if (shortLeg.parsed.strike >= longLeg.parsed.strike) {
            return null
        }
        return {
            structureType: "credit_vertical",
            verticalSpreadType: "bear_call_credit",
            underlying,
            expiration,
            legs: normalized.map((leg) => ({
                instrument: leg.symbol,
            })),
        }
    }

    if (longLeg.parsed.strike >= shortLeg.parsed.strike) {
        return null
    }
    return {
        structureType: "credit_vertical",
        verticalSpreadType: "bull_put_credit",
        underlying,
        expiration,
        legs: normalized.map((leg) => ({
            instrument: leg.symbol,
        })),
    }
}

function resolveOrderLegExposure(
    leg: NonNullable<Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]["legs"]>[number]
): "long" | "short" | null {
    const positionIntent = leg.position_intent?.toLowerCase()
    if (positionIntent === "sell_to_open" || positionIntent === "buy_to_close") {
        return "short"
    }
    if (positionIntent === "buy_to_open" || positionIntent === "sell_to_close") {
        return "long"
    }

    if (leg.side === "sell") {
        return "short"
    }
    if (leg.side === "buy") {
        return "long"
    }

    return null
}

export function computeAlpacaStructurePrices(
    legs: Array<{
        side: string
        bid?: number
        ask?: number
        midpoint?: number
    }>
): PriceVerification["livePrices"] {
    if (legs.length === 0) {
        return {}
    }

    const rawBid = legs.every((leg) => leg.bid !== undefined && leg.ask !== undefined)
        ? roundPrice(legs.reduce((sum, leg) => {
            return sum + (leg.side.startsWith("sell") ? (leg.bid ?? 0) : -(leg.ask ?? 0))
        }, 0))
        : undefined
    const rawAsk = legs.every((leg) => leg.bid !== undefined && leg.ask !== undefined)
        ? roundPrice(legs.reduce((sum, leg) => {
            return sum + (leg.side.startsWith("sell") ? (leg.ask ?? 0) : -(leg.bid ?? 0))
        }, 0))
        : undefined
    const rawMid = legs.every((leg) => leg.midpoint !== undefined)
        ? roundPrice(legs.reduce((sum, leg) => {
            return sum + (leg.side.startsWith("sell") ? 1 : -1) * (leg.midpoint ?? 0)
        }, 0))
        : undefined
    const bid = rawBid !== undefined && rawAsk !== undefined
        ? roundPrice(Math.min(Math.abs(rawBid), Math.abs(rawAsk)))
        : rawBid !== undefined
            ? roundPrice(Math.abs(rawBid))
            : undefined
    const ask = rawBid !== undefined && rawAsk !== undefined
        ? roundPrice(Math.max(Math.abs(rawBid), Math.abs(rawAsk)))
        : rawAsk !== undefined
            ? roundPrice(Math.abs(rawAsk))
            : undefined
    const mid = rawMid !== undefined
        ? roundPrice(Math.abs(rawMid))
        : undefined
    const spread = bid !== undefined && ask !== undefined
        ? roundPrice(Math.abs(ask - bid))
        : undefined

    return {
        bid,
        ask,
        mid,
        spread,
    }
}
