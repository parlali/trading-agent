export function toDecimalString(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot serialize non-finite number as decimal string: ${value}`)
    }

    if (Object.is(value, -0) || value === 0) {
        return "0"
    }

    return String(value)
}

export function toUnsignedIntString(value: number): string {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(`Cannot serialize non-negative integer as unsigned-int string: ${value}`)
    }

    return String(value)
}

export function fromDecimalString(value: string | null | undefined, field: string): number {
    if (value === null || value === undefined || value.trim() === "") {
        throw new Error(`Missing decimal string for ${field}`)
    }

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid decimal string for ${field}: ${value}`)
    }

    return parsed
}

export function fromOptionalDecimalString(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value.trim() === "") {
        return undefined
    }

    return fromDecimalString(value, "optional")
}

export function fromUnsignedIntString(value: string | null | undefined, field: string): number {
    if (value === null || value === undefined || value.trim() === "") {
        throw new Error(`Missing unsigned-int string for ${field}`)
    }

    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`Invalid unsigned-int string for ${field}: ${value}`)
    }

    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Unsafe unsigned-int string for ${field}: ${value}`)
    }

    return parsed
}

export function fromOptionalUnsignedIntString(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value.trim() === "") {
        return undefined
    }

    return fromUnsignedIntString(value, "optional")
}
