import type { HttpMcpTool } from "./http-client"

export function readMcpSafetyBlock(remoteTool: HttpMcpTool): string | undefined {
    const destructiveHint = remoteTool.annotations?.destructiveHint as unknown
    const openWorldHint = remoteTool.annotations?.openWorldHint as unknown

    return readBlockingMcpSafetyHint("destructiveHint", destructiveHint) ??
        readBlockingMcpSafetyHint("openWorldHint", openWorldHint)
}

export function normalizeMcpInputSchema(
    schema: Record<string, unknown> | undefined
): { schema: Record<string, unknown> | null, reason?: string } {
    if (!schema) {
        return {
            schema: {
                type: "object",
                properties: {},
            },
        }
    }

    if (schema.type && schema.type !== "object") {
        return {
            schema: null,
            reason: "schema type must be object",
        }
    }

    const normalized = schema.type
        ? schema
        : {
            ...schema,
            type: "object",
        }

    const invalidFieldReason = readInvalidObjectSchemaFieldReason(normalized)

    return invalidFieldReason
        ? { schema: null, reason: invalidFieldReason }
        : { schema: normalized }
}

export function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

export function isAdditionalPropertiesSchema(value: unknown): boolean {
    return typeof value === "boolean" ||
        (Boolean(value) && typeof value === "object" && !Array.isArray(value))
}

function readBlockingMcpSafetyHint(name: string, value: unknown): string | undefined {
    if (value === undefined || value === false) {
        return undefined
    }

    if (value === true) {
        return `${name} is true`
    }

    return `${name} is malformed`
}

function readInvalidObjectSchemaFieldReason(schema: Record<string, unknown>): string | undefined {
    if (schema.properties !== undefined && !isSchemaProperties(schema.properties)) {
        return "properties must be an object with object-valued fields"
    }

    if (schema.required !== undefined && !isStringArray(schema.required)) {
        return "required must be a string array"
    }

    if (schema.additionalProperties !== undefined && !isAdditionalPropertiesSchema(schema.additionalProperties)) {
        return "additionalProperties must be boolean or an object schema"
    }

    return undefined
}

function isSchemaProperties(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false
    }

    return Object.values(value as Record<string, unknown>).every((entry) =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
}
