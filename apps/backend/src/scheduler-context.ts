import type {
    Position,
    OpenRouterLlmProviderConfig,
    WorkingOrder,
} from "@valiq-trading/core"

export function mergeRuntimeContextLines(
    existing: string[] | undefined,
    additional: string[]
): string[] | undefined {
    if (additional.length === 0) {
        return existing
    }

    return [...(existing ?? []), ...additional]
}

export function readOpenRouterReasoningConfig(
    llm: OpenRouterLlmProviderConfig
): { effort: "low" | "medium" | "high"; exclude: boolean } | undefined {
    return llm.reasoning
        ? {
            effort: llm.reasoning.effort,
            exclude: llm.reasoning.exclude !== false,
        }
        : undefined
}

export function buildPromptBlockedIdentifiers(args: {
    allPositions: Position[]
    ownedPositions: Position[]
    allWorkingOrders: WorkingOrder[]
    ownedWorkingOrders: WorkingOrder[]
    policy: Record<string, unknown>
}): string[] {
    const ownedPositionKeys = new Set(args.ownedPositions.map(buildPositionPromptKey))
    const ownedOrderIds = new Set(args.ownedWorkingOrders.map((order) => order.orderId))
    const expectedExternal = readExpectedExternalIdentifiers(args.policy)
    const blocked = new Set<string>(expectedExternal)

    for (const position of args.allPositions) {
        if (ownedPositionKeys.has(buildPositionPromptKey(position)) && !matchesExpectedExternal(position, expectedExternal)) {
            continue
        }

        addPositionIdentifiers(blocked, position)
    }

    for (const order of args.allWorkingOrders) {
        if (ownedOrderIds.has(order.orderId) && !matchesExpectedExternal(order, expectedExternal)) {
            continue
        }

        addWorkingOrderIdentifiers(blocked, order)
    }

    return Array.from(blocked).sort((left, right) => left.localeCompare(right))
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object"
        ? value as Record<string, unknown>
        : undefined
}

function readExpectedExternalIdentifiers(policy: Record<string, unknown>): Set<string> {
    const safety = readRecord(policy.safety)
    const expected = safety?.expectedExternalInstruments
    const identifiers = new Set<string>()

    if (!Array.isArray(expected)) {
        return identifiers
    }

    for (const value of expected) {
        addPromptIdentifier(identifiers, value)
    }

    return identifiers
}

function buildPositionPromptKey(position: Position): string {
    return `${position.instrument}:${position.providerPositionId ?? position.side}`
}

function matchesExpectedExternal(
    value: Position | WorkingOrder,
    expectedExternal: Set<string>
): boolean {
    if (expectedExternal.size === 0) {
        return false
    }

    const identifiers = new Set<string>()
    if ("orderId" in value) {
        addWorkingOrderIdentifiers(identifiers, value)
    } else {
        addPositionIdentifiers(identifiers, value)
    }

    for (const identifier of identifiers) {
        if (expectedExternal.has(identifier)) {
            return true
        }
    }

    return false
}

function addPositionIdentifiers(identifiers: Set<string>, position: Position): void {
    addPromptIdentifier(identifiers, position.instrument)
    addPromptIdentifier(identifiers, position.providerPositionId)
    addMetadataIdentifiers(identifiers, position.metadata)
}

function addWorkingOrderIdentifiers(identifiers: Set<string>, order: WorkingOrder): void {
    addPromptIdentifier(identifiers, order.instrument)
    addPromptIdentifier(identifiers, order.orderId)
    addMetadataIdentifiers(identifiers, order.metadata)
}

function addMetadataIdentifiers(identifiers: Set<string>, metadata: Record<string, unknown> | undefined): void {
    if (!metadata) {
        return
    }

    for (const key of ["tokenId", "conditionId", "market", "marketSlug", "slug", "question", "instrument"]) {
        addPromptIdentifier(identifiers, metadata[key])
    }
}

function addPromptIdentifier(identifiers: Set<string>, value: unknown): void {
    if (typeof value !== "string") {
        return
    }

    const normalized = value.trim()
    if (normalized.length < 4) {
        return
    }

    identifiers.add(normalized)
}
