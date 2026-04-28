import type { Position, WorkingOrder } from "./types"

export function resolveProviderPositionId(position: {
    providerPositionId?: string
    metadata?: Record<string, unknown>
}): string | undefined {
    if (position.providerPositionId) {
        return position.providerPositionId
    }

    return firstStringish(
        position.metadata?.ticket,
        position.metadata?.identifier,
        position.metadata?.posId,
        position.metadata?.positionId,
        position.metadata?.providerPositionId
    )
}

export function buildProviderPositionKey(position: Pick<Position, "instrument" | "side" | "providerPositionId" | "metadata">): string {
    const providerPositionId = resolveProviderPositionId(position)
    if (providerPositionId) {
        return `${position.instrument}:${providerPositionId}`
    }

    return `${position.instrument}:${position.side}`
}

export function buildProviderWorkingOrderKey(order: Pick<WorkingOrder, "orderId">): string {
    return order.orderId
}

function firstStringish(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim()
        }

        if (typeof value === "number" && Number.isFinite(value)) {
            return String(value)
        }
    }

    return undefined
}
