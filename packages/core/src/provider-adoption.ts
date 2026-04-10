import type { ProviderOwnershipStatus } from "./types"

export interface ProviderAdoptionRow {
    instrument: string
    ownershipStatus: ProviderOwnershipStatus
    strategyId?: string
}

export interface ProviderAdoptionClaim {
    instrument: string
    strategyId: string
}

interface ResolveProviderAdoptionInstrumentsArgs {
    targetStrategyId: string
    requestedInstruments?: string[]
    rows: ProviderAdoptionRow[]
    claims?: ProviderAdoptionClaim[]
}

function normalizeInstruments(instruments?: string[]): string[] {
    if (!instruments) {
        return []
    }

    return Array.from(
        new Set(
            instruments
                .map((instrument) => instrument.trim())
                .filter((instrument) => instrument.length > 0)
        )
    )
}

function formatInstrumentList(instruments: string[]): string {
    return instruments.join(", ")
}

export function resolveProviderAdoptionInstruments(
    args: ResolveProviderAdoptionInstrumentsArgs
): string[] {
    const rowsByInstrument = new Map<string, ProviderAdoptionRow[]>()

    for (const row of args.rows) {
        const existing = rowsByInstrument.get(row.instrument) ?? []
        existing.push(row)
        rowsByInstrument.set(row.instrument, existing)
    }

    const currentExposureInstruments = Array.from(
        new Set(
            args.rows
                .filter((row) => row.ownershipStatus !== "owned")
                .map((row) => row.instrument)
        )
    ).sort()

    const requestedInstruments = normalizeInstruments(args.requestedInstruments)
    const instruments = requestedInstruments.length > 0
        ? requestedInstruments
        : currentExposureInstruments

    if (instruments.length === 0) {
        return []
    }

    const instrumentSet = new Set(instruments)
    const extra = instruments.filter((instrument) => !currentExposureInstruments.includes(instrument))
    const missing = currentExposureInstruments.filter((instrument) => !instrumentSet.has(instrument))

    if (extra.length > 0 || missing.length > 0) {
        const details = [
            extra.length > 0
                ? `extra=${formatInstrumentList(extra)}`
                : undefined,
            missing.length > 0
                ? `missing=${formatInstrumentList(missing)}`
                : undefined,
        ].filter((detail): detail is string => detail !== undefined)

        throw new Error(
            `Requested instruments must exactly match the current unowned exposure set (${details.join("; ")})`
        )
    }

    for (const instrument of instruments) {
        const instrumentRows = rowsByInstrument.get(instrument) ?? []
        const adoptableRows = instrumentRows.filter((row) => row.ownershipStatus !== "owned")
        const ownedRows = instrumentRows.filter((row) => row.ownershipStatus === "owned")

        if (adoptableRows.length === 0) {
            throw new Error(`Cannot adopt ${instrument}: no unowned or orphaned provider exposure exists`)
        }

        if (ownedRows.length > 0) {
            throw new Error(
                `Cannot adopt ${instrument}: mixed ownership detected between owned and unowned provider rows`
            )
        }

        const conflictingClaims = (args.claims ?? []).filter(
            (claim) =>
                claim.instrument === instrument &&
                claim.strategyId !== args.targetStrategyId
        )

        if (conflictingClaims.length > 0) {
            throw new Error(
                `Cannot adopt ${instrument}: active claim belongs to another strategy (${formatInstrumentList(conflictingClaims.map((claim) => claim.strategyId))})`
            )
        }
    }

    return instruments
}
