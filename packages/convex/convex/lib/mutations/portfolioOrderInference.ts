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
            mt5PositionMatchesOrderIdentity(order, position)
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

    if (args.app === "alpaca-options" && isEntryLikeOrder(order)) {
        const alpacaInference = inferAlpacaEntryFillFromClaimedLegs(order, args.livePositions)
        if (alpacaInference) {
            return alpacaInference
        }
    } else if (isEntryLikeOrder(order)) {
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

function inferAlpacaEntryFillFromClaimedLegs(
    order: OrderDoc,
    livePositions: Array<{
        instrument: string
        side: "long" | "short"
        quantity: number
        entryPrice: number
    }>
): {
    status: Doc<"orders">["status"]
    filledQuantity: number
    remainingQuantity: number
    avgFillPrice?: number
} | undefined {
    const legs = readAlpacaClaimedOrderLegs(order.intent)
    if (legs.length !== 2 && legs.length !== 4) {
        return undefined
    }

    const liveByInstrument = new Map(
        livePositions.map((position) => [position.instrument.trim().toUpperCase(), position])
    )
    const matchedLegs = legs.map((leg) => {
        const position = liveByInstrument.get(leg.instrument)
        if (!position || position.side !== leg.expectedPositionSide || position.quantity <= 0) {
            return undefined
        }

        return {
            leg,
            position,
            filledStructures: Math.floor(position.quantity / leg.ratio),
        }
    })

    if (matchedLegs.some((entry) => !entry)) {
        return undefined
    }

    const completeMatchedLegs = matchedLegs as Array<{
        leg: {
            ratio: number
            expectedPositionSide: "long" | "short"
        }
        position: {
            side: "long" | "short"
            entryPrice: number
        }
        filledStructures: number
    }>
    const filledQuantity = Math.min(
        order.quantity,
        ...completeMatchedLegs.map((entry) => entry.filledStructures)
    )
    if (!Number.isFinite(filledQuantity) || filledQuantity <= 0) {
        return undefined
    }

    const avgFillPrice = Math.abs(
        completeMatchedLegs.reduce((sum, entry) => {
            const multiplier = entry.position.side === "short" ? -1 : 1
            return sum + entry.position.entryPrice * multiplier * entry.leg.ratio
        }, 0)
    )

    return {
        status: filledQuantity >= order.quantity ? "filled" : "partially_filled",
        filledQuantity,
        remainingQuantity: Math.max(order.quantity - filledQuantity, 0),
        avgFillPrice: Number.isFinite(avgFillPrice) && avgFillPrice > 0
            ? Math.round(avgFillPrice * 100) / 100
            : order.avgFillPrice,
    }
}

function readAlpacaClaimedOrderLegs(intent: unknown): Array<{
    instrument: string
    ratio: number
    expectedPositionSide: "long" | "short"
}> {
    if (!isRecord(intent) || !Array.isArray(intent.legs)) {
        return []
    }

    return intent.legs
        .filter(isRecord)
        .map((leg) => {
            const instrument = typeof leg.instrument === "string"
                ? leg.instrument.trim().toUpperCase()
                : ""
            const ratio = typeof leg.quantity === "number" && Number.isInteger(leg.quantity) && leg.quantity > 0
                ? leg.quantity
                : 1
            const expectedPositionSide = leg.side === "sell_to_open"
                ? "short"
                : leg.side === "buy_to_open"
                    ? "long"
                    : undefined

            return instrument && expectedPositionSide
                ? {
                    instrument,
                    ratio,
                    expectedPositionSide,
                }
                : undefined
        })
        .filter((leg): leg is {
            instrument: string
            ratio: number
            expectedPositionSide: "long" | "short"
        } => Boolean(leg))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
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

function mt5PositionMatchesOrderIdentity(
    order: OrderDoc,
    position: {
        providerPositionId?: string
        metadata?: string
    }
): boolean {
    const identifiers = new Set<string>()
    addIdentifier(identifiers, position.providerPositionId)
    addIdentifier(identifiers, extractMt5Ticket(position.metadata))
    addIdentifier(identifiers, extractMt5Comment(position.metadata))

    if (identifiers.size === 0) {
        return false
    }

    return getOrderProviderIdentifiers(order).some((identifier) => identifiers.has(identifier))
}

function getOrderProviderIdentifiers(order: OrderDoc): string[] {
    return [
        order.providerOrderId,
        order.providerClientOrderId,
        ...(order.providerOrderAliases ?? []),
        order.orderId,
    ]
        .filter((identifier): identifier is string => typeof identifier === "string" && identifier.trim().length > 0)
        .map((identifier) => identifier.trim())
}

function addIdentifier(identifiers: Set<string>, value: string | undefined): void {
    if (typeof value === "string" && value.trim().length > 0) {
        identifiers.add(value.trim())
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
    const parsed = parseMt5Metadata(metadata)
    if (typeof parsed?.ticket === "number" || typeof parsed?.ticket === "string") {
        return String(parsed.ticket)
    }

    return undefined
}

export function extractMt5Comment(metadata?: string): string | undefined {
    const parsed = parseMt5Metadata(metadata)
    return typeof parsed?.comment === "string" && parsed.comment.trim().length > 0
        ? parsed.comment.trim()
        : undefined
}

function parseMt5Metadata(metadata?: string): Record<string, unknown> | undefined {
    if (!metadata) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata)
        return isRecord(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}
