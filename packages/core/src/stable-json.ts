export function stableJsonKey(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJsonKey(entry)).join(",")}]`
    }

    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonKey(entry)}`)
            .join(",")}}`
    }

    return JSON.stringify(value)
}

export function compareCodeUnits(left: string, right: string): number {
    if (left < right) {
        return -1
    }
    if (left > right) {
        return 1
    }

    return 0
}
