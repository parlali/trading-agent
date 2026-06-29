import type { Position } from "@valiq-trading/core"
import {
    resolveProviderPositionTarget,
    type ProviderPositionTargetResult,
} from "./provider-position-target"

export interface OKXPositionTargetInput {
    instrument: string
    providerPositionId?: string
    providerPositionKey?: string
    positionSide?: Position["side"]
}

export type OKXPositionTargetResult = ProviderPositionTargetResult

export function resolveOKXPositionTarget(
    positions: readonly Position[],
    input: OKXPositionTargetInput,
    action: "close" | "adjustment"
): OKXPositionTargetResult {
    return resolveProviderPositionTarget(positions, input, {
        venueLabel: "OKX swap",
        action,
    })
}
