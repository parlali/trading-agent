import { readFiniteNumber } from "./value-readers"

const STANDARD_OPTION_CONTRACT_MULTIPLIER = 100
const RAW_OCC_OPTION_SYMBOL_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/

export function resolveOptionContractMultiplier(
    instrument: string,
    metadata?: Record<string, unknown>
): number {
    const explicit = readFiniteNumber(metadata?.optionContractMultiplier) ??
        readFiniteNumber(metadata?.contractMultiplier) ??
        readFiniteNumber(metadata?.notionalMultiplier)
    if (explicit !== undefined && explicit > 0) {
        return explicit
    }

    return isStandardOptionInstrument(instrument)
        ? STANDARD_OPTION_CONTRACT_MULTIPLIER
        : 1
}

export function isStandardOptionInstrument(instrument: string): boolean {
    const normalized = instrument.trim().toUpperCase()
    return normalized.startsWith("VS:") ||
        normalized.startsWith("IC:") ||
        RAW_OCC_OPTION_SYMBOL_RE.test(normalized)
}
