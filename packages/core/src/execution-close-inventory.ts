import type {
    ExecutionErrorDetail,
    OrderIntent,
    Position,
    ValidationResult,
} from "./types"
import { readPositionSide } from "./execution-metadata"
import {
    buildProviderPositionKeyAliases,
    resolveProviderPositionId,
} from "./provider-position-key"
import { createExecutionErrorDetail } from "./utils"

const CLOSE_QUANTITY_EPSILON = 1e-9

export interface CloseInventoryValidationFailure {
    validation: ValidationResult
    errorDetail: ExecutionErrorDetail
}

export function validateCloseIntentInventory(args: {
    intent: OrderIntent
    positions: Position[]
}): CloseInventoryValidationFailure | undefined {
    if (args.intent.legs && args.intent.legs.length > 0) {
        for (const leg of args.intent.legs) {
            const heldSide = resolveHeldSideForCloseSide(leg.side)
            const requestedQuantity = args.intent.quantity * leg.quantity
            const failure = validateCloseQuantity({
                positions: args.positions,
                instrument: leg.instrument,
                heldSide,
                requestedQuantity,
            })
            if (failure) {
                return failure
            }
        }

        return undefined
    }

    const heldSide = readPositionSide(args.intent.metadata?.positionSide) ??
        resolveHeldSideForCloseSide(args.intent.side)
    return validateCloseQuantity({
        positions: args.positions,
        instrument: args.intent.instrument,
        heldSide,
        requestedQuantity: args.intent.quantity,
        providerPositionId: readMetadataString(args.intent.metadata, "providerPositionId"),
        providerPositionKey: readMetadataString(args.intent.metadata, "providerPositionKey"),
    })
}

function validateCloseQuantity(args: {
    positions: Position[]
    instrument: string
    heldSide: Position["side"]
    requestedQuantity: number
    providerPositionId?: string
    providerPositionKey?: string
}): CloseInventoryValidationFailure | undefined {
    const remainingQuantity = resolveRemainingCloseQuantity(args)

    if (remainingQuantity <= CLOSE_QUANTITY_EPSILON) {
        return createCloseInventoryFailure({
            code: "POSITION_ALREADY_CLOSED",
            message: `Position already closed for ${args.instrument} ${args.heldSide}; requested close quantity ${formatQuantity(args.requestedQuantity)} but remaining owned inventory is 0`,
            instrument: args.instrument,
            heldSide: args.heldSide,
            requestedQuantity: args.requestedQuantity,
            remainingQuantity: 0,
            providerPositionId: args.providerPositionId,
            providerPositionKey: args.providerPositionKey,
        })
    }

    if (!Number.isFinite(args.requestedQuantity) || args.requestedQuantity <= 0) {
        return createCloseInventoryFailure({
            code: "INVALID_CLOSE_QUANTITY",
            message: `Close quantity for ${args.instrument} ${args.heldSide} must be positive; requested ${formatQuantity(args.requestedQuantity)} with remaining owned inventory ${formatQuantity(remainingQuantity)}`,
            instrument: args.instrument,
            heldSide: args.heldSide,
            requestedQuantity: args.requestedQuantity,
            remainingQuantity,
            providerPositionId: args.providerPositionId,
            providerPositionKey: args.providerPositionKey,
        })
    }

    if (args.requestedQuantity > remainingQuantity + CLOSE_QUANTITY_EPSILON) {
        return createCloseInventoryFailure({
            code: "CLOSE_EXCEEDS_REMAINING_INVENTORY",
            message: `Close quantity for ${args.instrument} ${args.heldSide} exceeds remaining owned inventory; requested ${formatQuantity(args.requestedQuantity)} but remaining is ${formatQuantity(remainingQuantity)}`,
            instrument: args.instrument,
            heldSide: args.heldSide,
            requestedQuantity: args.requestedQuantity,
            remainingQuantity,
            providerPositionId: args.providerPositionId,
            providerPositionKey: args.providerPositionKey,
        })
    }

    return undefined
}

function resolveRemainingCloseQuantity(args: {
    positions: Position[]
    instrument: string
    heldSide: Position["side"]
    providerPositionId?: string
    providerPositionKey?: string
}): number {
    const candidates = args.positions.filter((position) =>
        position.instrument === args.instrument &&
        position.side === args.heldSide &&
        matchesProviderIdentity(position, args.providerPositionId, args.providerPositionKey)
    )

    return candidates.reduce((sum, position) => sum + position.quantity, 0)
}

function matchesProviderIdentity(
    position: Position,
    providerPositionId: string | undefined,
    providerPositionKey: string | undefined
): boolean {
    if (!providerPositionId && !providerPositionKey) {
        return true
    }

    const aliases = buildProviderPositionKeyAliases(position)
    const resolvedProviderPositionId = resolveProviderPositionId(position)

    return providerPositionKey !== undefined && aliases.includes(providerPositionKey) ||
        providerPositionId !== undefined && (
            position.providerPositionId === providerPositionId ||
            resolvedProviderPositionId === providerPositionId ||
            aliases.includes(`${position.instrument}:${providerPositionId}`)
        )
}

function resolveHeldSideForCloseSide(side: OrderIntent["side"] | NonNullable<OrderIntent["legs"]>[number]["side"]): Position["side"] {
    return side === "buy" || side === "buy_to_close"
        ? "short"
        : "long"
}

function createCloseInventoryFailure(args: {
    code: string
    message: string
    instrument: string
    heldSide: Position["side"]
    requestedQuantity: number
    remainingQuantity: number
    providerPositionId?: string
    providerPositionKey?: string
}): CloseInventoryValidationFailure {
    const errorDetail = createExecutionErrorDetail("pre_validation", args.message, {
        code: args.code,
        retryable: false,
        details: {
            instrument: args.instrument,
            heldSide: args.heldSide,
            requestedQuantity: args.requestedQuantity,
            remainingQuantity: args.remainingQuantity,
            providerPositionId: args.providerPositionId,
            providerPositionKey: args.providerPositionKey,
        },
    })

    return {
        validation: {
            allowed: false,
            reason: args.message,
        },
        errorDetail,
    }
}

function readMetadataString(
    metadata: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const value = metadata?.[key]
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function formatQuantity(value: number): string {
    return Number.isFinite(value)
        ? String(value)
        : "invalid"
}
