import type { OrderIntent, Position } from "./types"
import type { ClosePositionOptions } from "./execution-contracts"
import {
    readNumber,
    readPositionSide,
} from "./execution-metadata"

export function resolveCloseOrderSide(position?: Pick<Position, "side">): "buy" | "sell" {
    return position?.side === "long" ? "sell" : "buy"
}

export function buildClosePositionIntent(args: {
    instrument: string
    position?: Position
    venueIntent?: OrderIntent
    reason?: string
    options: ClosePositionOptions
}): OrderIntent {
    const closeSide = resolveCloseOrderSide(args.position)
    const venueMetadata = args.venueIntent?.metadata
    const venueEntryPrice = readNumber(venueMetadata?.entryPrice)
    const venuePositionSide = readPositionSide(venueMetadata?.positionSide)
    const venueEstimatedPrice = readNumber(venueMetadata?.estimatedPrice)

    if (args.venueIntent) {
        return {
            ...args.venueIntent,
            metadata: {
                ...args.position?.metadata,
                ...args.options.metadata,
                ...venueMetadata,
                action: "close",
                reason: args.reason,
                entryPrice: args.position?.entryPrice ?? venueEntryPrice,
                positionSide: args.position?.side ?? venuePositionSide,
                estimatedPrice: args.options.estimatedPrice ?? venueEstimatedPrice,
            },
        }
    }

    return {
        instrument: args.instrument,
        side: closeSide,
        quantity: args.position?.quantity ?? 0,
        orderType: "market",
        timeInForce: "day",
        metadata: {
            ...args.position?.metadata,
            ...args.options.metadata,
            action: "close",
            reason: args.reason,
            entryPrice: args.position?.entryPrice,
            positionSide: args.position?.side,
            estimatedPrice: args.options.estimatedPrice,
        },
    }
}

export function buildProviderPositionCloseIntent(args: {
    position: Position
    reason?: string
    options: ClosePositionOptions
}): OrderIntent {
    return {
        instrument: args.position.instrument,
        side: resolveCloseOrderSide(args.position),
        quantity: args.position.quantity,
        orderType: "market",
        timeInForce: "ioc",
        metadata: {
            ...args.position.metadata,
            ...args.options.metadata,
            action: "close",
            reason: args.reason,
            providerPositionId: args.position.providerPositionId,
            entryPrice: args.position.entryPrice,
            positionSide: args.position.side,
            estimatedPrice: args.options.estimatedPrice ?? args.position.currentPrice ?? args.position.entryPrice,
        },
    }
}
