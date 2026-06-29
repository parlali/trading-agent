import type { Position, WorkingOrder } from "./types"

export type ProviderPositionIdentityInput = {
    instrument: string
    side: string
    providerPositionId?: string
    metadata?: Record<string, unknown> | string
}

export function resolveProviderPositionId(position: {
    providerPositionId?: string
    metadata?: Record<string, unknown> | string
}): string | undefined {
    if (position.providerPositionId) {
        return position.providerPositionId
    }

    const metadata = readProviderPositionMetadata(position.metadata)

    return firstStringish(
        metadata?.ticket,
        metadata?.identifier,
        metadata?.posId,
        metadata?.positionId,
        metadata?.providerPositionId
    )
}

export function buildProviderPositionKey(position: Pick<Position, "instrument" | "side" | "providerPositionId" | "metadata"> | ProviderPositionIdentityInput): string {
    const providerPositionId = resolveProviderPositionId(position)
    if (providerPositionId && !isRedundantInstrumentPositionId(position.instrument, providerPositionId)) {
        return `${position.instrument}:${providerPositionId}`
    }

    return `${position.instrument}:${position.side}`
}

export function buildProviderPositionKeyAliases(position: Pick<Position, "instrument" | "side" | "providerPositionId" | "metadata"> | ProviderPositionIdentityInput): string[] {
    const aliases = new Set<string>([buildProviderPositionKey(position)])
    const providerPositionId = resolveProviderPositionId(position)
    if (providerPositionId) {
        aliases.add(`${position.instrument}:${providerPositionId}`)
    }

    return Array.from(aliases)
}

export function buildProviderWorkingOrderKey(order: Pick<WorkingOrder, "orderId">): string {
    return order.orderId
}

function readProviderPositionMetadata(
    metadata: Record<string, unknown> | string | undefined
): Record<string, unknown> | undefined {
    if (!metadata) {
        return undefined
    }

    if (typeof metadata !== "string") {
        return metadata
    }

    try {
        const parsed = JSON.parse(metadata) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined
    } catch {
        return undefined
    }
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

function isRedundantInstrumentPositionId(instrument: string, providerPositionId: string): boolean {
    return providerPositionId.trim().toUpperCase() === instrument.trim().toUpperCase()
}
