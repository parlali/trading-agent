import {
    buildProviderPositionKey,
    resolveProviderPositionId,
    type Position,
} from "@valiq-trading/core"

export interface OKXPositionTargetInput {
    instrument: string
    providerPositionId?: string
    providerPositionKey?: string
    positionSide?: Position["side"]
}

export type OKXPositionTargetResult =
    | {
        ok: true
        instrument: string
        position: Position
    }
    | {
        ok: false
        code: string
        message: string
    }

export function resolveOKXPositionTarget(
    positions: readonly Position[],
    input: OKXPositionTargetInput,
    action: "close" | "adjustment"
): OKXPositionTargetResult {
    const instrument = input.instrument.trim().toUpperCase()
    const candidates = positions.filter((position) =>
        position.instrument.toUpperCase() === instrument &&
        Math.abs(position.quantity) > 0
    )

    if (candidates.length === 0) {
        return {
            ok: false,
            code: "POSITION_NOT_FOUND",
            message: `No open OKX swap position found for ${instrument}`,
        }
    }

    const providerPositionId = normalizeOptional(input.providerPositionId)
    const providerPositionKey = normalizeOptional(input.providerPositionKey)
    let filtered = candidates

    if (providerPositionId) {
        filtered = filtered.filter((position) =>
            resolveProviderPositionId(position) === providerPositionId ||
            buildProviderPositionKey(position) === providerPositionId
        )
    }

    if (providerPositionKey) {
        filtered = filtered.filter((position) => buildProviderPositionKey(position) === providerPositionKey)
    }

    if (input.positionSide) {
        filtered = filtered.filter((position) => position.side === input.positionSide)
    }

    if (filtered.length === 1) {
        return {
            ok: true,
            instrument,
            position: filtered[0]!,
        }
    }

    if (filtered.length === 0) {
        return {
            ok: false,
            code: "POSITION_IDENTITY_NOT_FOUND",
            message: `No open OKX swap position for ${instrument} matches the requested provider position identity`,
        }
    }

    return {
        ok: false,
        code: "AMBIGUOUS_POSITION_IDENTITY",
        message: `OKX ${action} for ${instrument} is ambiguous across ${filtered.length} live positions; provide providerPositionId, providerPositionKey, or positionSide`,
    }
}

function normalizeOptional(value: string | undefined): string | undefined {
    const normalized = value?.trim()
    return normalized ? normalized : undefined
}
