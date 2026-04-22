export function resolveProviderPositionId(
    providerPositionId: string | undefined,
    metadata: string | undefined
): string | undefined {
    if (providerPositionId) {
        return providerPositionId
    }

    const parsed = parseJson<Record<string, unknown>>(metadata)
    if (!parsed) {
        return undefined
    }

    const ticket = parsed.ticket
    if (typeof ticket === "string" || typeof ticket === "number") {
        return String(ticket)
    }

    const identifier = parsed.identifier
    if (typeof identifier === "string" || typeof identifier === "number") {
        return String(identifier)
    }

    const posId = parsed.posId
    if (typeof posId === "string" || typeof posId === "number") {
        return String(posId)
    }

    const positionId = parsed.positionId
    if (typeof positionId === "string" || typeof positionId === "number") {
        return String(positionId)
    }

    const nestedProviderPositionId = parsed.providerPositionId
    if (typeof nestedProviderPositionId === "string" || typeof nestedProviderPositionId === "number") {
        return String(nestedProviderPositionId)
    }

    return undefined
}

export function buildProviderPositionKey(position: {
    instrument: string
    providerPositionId?: string
    metadata?: string
    side: string
}): string {
    const providerPositionId = resolveProviderPositionId(position.providerPositionId, position.metadata)
    if (providerPositionId) {
        return `${position.instrument}:${providerPositionId}`
    }

    return `${position.instrument}:${position.side}`
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
        sourceId: position.positionKey ?? buildProviderPositionKey(position),
    }
}

function parseJson<T>(value: string | undefined): T | undefined {
    if (!value) {
        return undefined
    }

    try {
        return JSON.parse(value) as T
    } catch {
        return undefined
    }
}
