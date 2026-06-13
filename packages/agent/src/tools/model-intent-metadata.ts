export const RESERVED_INTENT_METADATA_KEYS = [
    "action",
    "riskReducing",
    "kind",
    "orderId",
    "providerPositionId",
    "positionId",
    "posId",
    "ticket",
    "magic",
    "signedOrderFingerprint",
    "optionContractMultiplier",
    "contractMultiplier",
    "notionalMultiplier",
    "cashAdjustment",
    "realizedPnl",
    "fillPnl",
    "logicalOrderSequence",
    "submitAttemptSequence",
] as const

export type ReservedIntentMetadataKey = typeof RESERVED_INTENT_METADATA_KEYS[number]

const RESERVED_KEY_SET: ReadonlySet<string> = new Set(RESERVED_INTENT_METADATA_KEYS)

export function sanitizeModelIntentMetadata(
    metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!metadata) {
        return undefined
    }

    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(metadata)) {
        if (!RESERVED_KEY_SET.has(key)) {
            sanitized[key] = value
        }
    }

    return sanitized
}
