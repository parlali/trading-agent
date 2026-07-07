import type { Doc } from "../../_generated/dataModel"
import {
    readIdentifier,
} from "./portfolioCloseIdentity"
import {
    parseJson,
} from "./portfolioUtils"

export function isVanishedPositionAccountingFault(
    fault: Pick<Doc<"execution_safety_faults">, "category" | "message">
): boolean {
    return fault.category === "accounting_mismatch" &&
        fault.message.includes("disappeared from") &&
        fault.message.includes("without close evidence")
}

export function readVanishedPositionFaultPayload(
    fault: Pick<Doc<"execution_safety_faults">, "instrument" | "providerPayload">
): {
    instrument?: string
    side?: "long" | "short"
    quantity?: number
    entryPrice?: number
    positionKey?: string
    providerPositionId?: string
} {
    const payload = parseJson<Record<string, unknown>>(fault.providerPayload)
    const instrument = readIdentifier(payload?.instrument) ?? fault.instrument
    const side = readProviderPositionSide(payload?.side)
    const quantity = readFinitePayloadNumber(payload?.quantity)
    const entryPrice = readFinitePayloadNumber(payload?.entryPrice)
    const positionKey = readIdentifier(payload?.positionKey) ?? (
        instrument && side ? `${instrument}:${side}` : undefined
    )

    return {
        instrument,
        side,
        quantity,
        entryPrice,
        positionKey,
        providerPositionId: resolveProviderPositionIdFromFaultPayload(instrument, positionKey, payload),
    }
}

function resolveProviderPositionIdFromFaultPayload(
    instrument: string | undefined,
    positionKey: string | undefined,
    payload: Record<string, unknown> | undefined
): string | undefined {
    const explicit = readIdentifier(payload?.providerPositionId)
    if (explicit) {
        return explicit
    }

    if (!instrument || !positionKey) {
        return undefined
    }

    const prefix = `${instrument}:`
    if (!positionKey.startsWith(prefix)) {
        return undefined
    }

    const suffix = positionKey.slice(prefix.length)
    return suffix && suffix !== "long" && suffix !== "short" ? suffix : undefined
}

function readProviderPositionSide(value: unknown): "long" | "short" | undefined {
    return value === "long" || value === "short" ? value : undefined
}

function readFinitePayloadNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}
