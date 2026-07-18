const OPENAPI_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const VOLUME_MAX_FRACTION_DIGITS = 8
const PRICE_MAX_FRACTION_DIGITS = 8
const UNSIGNED_32_MAX = 4_294_967_295

export function toVolumeDecimalString(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot serialize non-finite volume: ${value}`)
    }
    if (value <= 0) {
        throw new Error(`Volume must be a positive decimal, received: ${value}`)
    }

    const serialized = formatPlainDecimal(value, VOLUME_MAX_FRACTION_DIGITS)
    if (Number(serialized) === 0) {
        throw new Error(`Volume is too small to represent at ${VOLUME_MAX_FRACTION_DIGITS} fraction digits: ${value}`)
    }

    return serialized
}

export function toPriceDecimalString(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot serialize non-finite price: ${value}`)
    }
    if (value < 0) {
        throw new Error(`Price must be a non-negative decimal, received: ${value}`)
    }

    return formatPlainDecimal(value, PRICE_MAX_FRACTION_DIGITS)
}

export function toDecimalString(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot serialize non-finite number as decimal string: ${value}`)
    }

    if (Object.is(value, -0) || value === 0) {
        return "0"
    }

    return formatPlainDecimal(value, PRICE_MAX_FRACTION_DIGITS)
}

export function toUnsignedIntString(value: number): string {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(`Cannot serialize non-negative integer as unsigned-int string: ${value}`)
    }
    if (value > UNSIGNED_32_MAX) {
        throw new Error(`Unsigned-int string exceeds uint32 max: ${value}`)
    }

    return String(value)
}

export function fromDecimalString(value: string | null | undefined, field: string): number {
    if (value === null || value === undefined || value.trim() === "") {
        throw new Error(`Missing decimal string for ${field}`)
    }

    const trimmed = value.trim()
    if (!OPENAPI_DECIMAL_PATTERN.test(trimmed)) {
        throw new Error(`Invalid decimal string for ${field}: ${value}`)
    }
    if (/[eE]/.test(trimmed)) {
        throw new Error(`Scientific notation is not allowed for ${field}: ${value}`)
    }

    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid decimal string for ${field}: ${value}`)
    }

    const significantDigits = trimmed.replace("-", "").replace(/^0+(?=\d)/, "").replace(".", "")
    if (significantDigits.length > 15) {
        throw new Error(`Decimal string for ${field} exceeds safe precision: ${value}`)
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
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UNSIGNED_32_MAX) {
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

export function fromSafeIntegerString(value: string | null | undefined, field: string): number {
    if (value === null || value === undefined || value.trim() === "") {
        throw new Error(`Missing integer string for ${field}`)
    }

    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`Invalid integer string for ${field}: ${value}`)
    }

    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Integer string for ${field} exceeds safe precision: ${value}`)
    }

    return parsed
}

export function fromOptionalSafeIntegerString(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value.trim() === "") {
        return undefined
    }

    return fromSafeIntegerString(value, "optional")
}

function formatPlainDecimal(value: number, maxFractionDigits: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot serialize non-finite number: ${value}`)
    }

    const negative = value < 0
    const absolute = Math.abs(value)
    if (absolute >= 1e15) {
        throw new Error(`Decimal magnitude exceeds safe plain serialization: ${value}`)
    }

    const factor = 10 ** maxFractionDigits
    const scaled = Math.round(absolute * factor)
    if (!Number.isSafeInteger(scaled)) {
        throw new Error(`Serialized decimal is not OpenAPI-safe: ${value}`)
    }
    const whole = Math.trunc(scaled / factor)
    const fraction = scaled % factor
    const fractionText = fraction
        .toString()
        .padStart(maxFractionDigits, "0")
        .replace(/0+$/, "")

    const normalized = fractionText.length > 0
        ? `${whole}.${fractionText}`
        : String(whole)

    if (!OPENAPI_DECIMAL_PATTERN.test(normalized) || /[eE]/.test(normalized)) {
        throw new Error(`Serialized decimal is not OpenAPI-safe: ${value} -> ${normalized}`)
    }

    return negative ? `-${normalized}` : normalized
}
