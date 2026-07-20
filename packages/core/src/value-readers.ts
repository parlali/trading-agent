export function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

export function readNonNegativeFiniteNumber(value: unknown): number | undefined {
    const candidate = readFiniteNumber(value)
    return candidate !== undefined && candidate >= 0
        ? candidate
        : undefined
}

export function readTrimmedString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}
