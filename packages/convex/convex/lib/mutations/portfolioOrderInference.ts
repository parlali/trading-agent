import type { Doc } from "../../_generated/dataModel"
import { getClaimInstrumentsForOrder, getProviderInstrumentClaimAliases } from "../instrumentClaims"
import type { OrderDoc } from "./portfolioTypes"
import { isEntryLikeOrder } from "./portfolioUtils"

export function inferClosedOrderStatus(args: {
    app: Doc<"strategies">["app"]
    order: OrderDoc
    livePositions: Array<{
        instrument: string
        providerPositionId?: string
        side: "long" | "short"
        quantity: number
        entryPrice: number
        metadata?: string
    }>
}): {
    status: Doc<"orders">["status"]
    filledQuantity?: number
    remainingQuantity?: number
    avgFillPrice?: number
} {
    const order = args.order

    if (order.filledQuantity > 0) {
        return createFilledOrderInference(order, order.filledQuantity, order.avgFillPrice)
    }

    if (args.app === "mt5") {
        const matchingPosition = args.livePositions.find((position) =>
            position.instrument === order.instrument &&
            mt5PositionMatchesOrderDirection(order, position.side) &&
            extractMt5Ticket(position.metadata) === order.orderId
        )

        if (matchingPosition) {
            const resolvedFilledQuantity = matchingPosition.quantity > 0
                ? Math.min(order.quantity, matchingPosition.quantity)
                : order.quantity

            return createFilledOrderInference(
                order,
                resolvedFilledQuantity,
                matchingPosition.entryPrice > 0
                    ? matchingPosition.entryPrice
                    : order.avgFillPrice
            )
        }
    }

    if (isEntryLikeOrder(order)) {
        const orderAliases = new Set(getClaimInstrumentsForOrder(order.instrument, order.intent))
        const matchingPositions = args.livePositions.filter((position) =>
            entryOrderMatchesLivePositionInstrument(args.app, orderAliases, position.instrument) &&
            positionMatchesOrderDirection(order, position.side)
        )
        if (matchingPositions.length === 1) {
            const [matchingPosition] = matchingPositions
            if (matchingPosition) {
                const resolvedFilledQuantity = matchingPosition.quantity > 0
                    ? Math.min(order.quantity, matchingPosition.quantity)
                    : order.quantity

                return createFilledOrderInference(
                    order,
                    resolvedFilledQuantity,
                    matchingPosition.entryPrice > 0
                        ? matchingPosition.entryPrice
                        : order.avgFillPrice
                )
            }
        }
    }

    if (order.action === "close" && !hasMatchingLivePositionForClose(order, args.livePositions)) {
        return {
            status: "filled",
            filledQuantity: order.quantity,
            remainingQuantity: 0,
            avgFillPrice: order.avgFillPrice,
        }
    }

    return {
        status: "cancelled",
    }
}

export function entryOrderMatchesLivePositionInstrument(
    app: Doc<"strategies">["app"],
    orderAliases: Set<string>,
    liveInstrument: string
): boolean {
    const liveAliases = getProviderInstrumentClaimAliases(app, liveInstrument)
    return liveAliases.some((alias) => orderAliases.has(alias))
}

function createFilledOrderInference(
    order: Pick<OrderDoc, "quantity">,
    filledQuantity: number,
    avgFillPrice: number | undefined
): {
    status: Doc<"orders">["status"]
    filledQuantity: number
    remainingQuantity: number
    avgFillPrice?: number
} {
    return {
        status: "filled",
        filledQuantity,
        remainingQuantity: Math.max(order.quantity - filledQuantity, 0),
        avgFillPrice,
    }
}

export function mt5PositionMatchesOrderDirection(order: OrderDoc, side: "long" | "short"): boolean {
    return positionMatchesOrderDirection(order, side)
}

export function positionMatchesOrderDirection(order: OrderDoc, side: "long" | "short"): boolean {
    if (order.intent.side === "buy") {
        return side === "long"
    }
    if (order.intent.side === "sell") {
        return side === "short"
    }
    return true
}

export function hasMatchingLivePositionForClose(
    order: OrderDoc,
    livePositions: Array<{
        instrument: string
        side: "long" | "short"
    }>
): boolean {
    const rawMetadata = order.intent?.metadata
    const metadata = rawMetadata && typeof rawMetadata === "object"
        ? rawMetadata as Record<string, unknown>
        : undefined
    const expectedPositionSide = metadata?.positionSide === "short"
        ? "short"
        : "long"

    return livePositions.some((position) =>
        position.instrument === order.instrument &&
        position.side === expectedPositionSide
    )
}

export function extractMt5Ticket(metadata?: string): string | undefined {
    if (!metadata) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata) as { ticket?: unknown }
        if (typeof parsed.ticket === "number" || typeof parsed.ticket === "string") {
            return String(parsed.ticket)
        }
    } catch {
        return undefined
    }

    return undefined
}
