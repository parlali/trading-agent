import {
    buildProviderPositionKey as buildCoreProviderPositionKey,
    resolveProviderPositionId as resolveCoreProviderPositionId,
} from "@valiq-trading/core"

export function resolveProviderPositionId(
    providerPositionId: string | undefined,
    metadata: string | undefined
): string | undefined {
    return resolveCoreProviderPositionId({ providerPositionId, metadata })
}

export function buildProviderPositionKey(position: {
    instrument: string
    providerPositionId?: string
    metadata?: string
    side: string
}): string {
    return buildCoreProviderPositionKey(position)
}

export function buildPositionClaim(position: {
    instrument: string
    side: string
    positionKey?: string
    providerPositionId?: string
    metadata?: string
}): {
    instrument: string
    sourceId: string
} {
    return {
        instrument: position.instrument,
        sourceId: position.instrument,
    }
}
