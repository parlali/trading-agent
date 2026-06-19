import { z } from "zod"
import {
    normalizeMT5Symbol,
    resolveMT5AllowedSymbol,
} from "@valiq-trading/mt5"
import type { ToolBinding } from "../tool-registry"

export function withMT5SymbolAllowList(
    tool: ToolBinding,
    field: "symbol" | "instrument",
    allowedSymbols: readonly string[]
): ToolBinding {
    const normalizedAllowedSymbols = normalizeAllowedSymbols(allowedSymbols)
    const allowedLabel = normalizedAllowedSymbols.length > 0
        ? normalizedAllowedSymbols.join(", ")
        : "none"

    return {
        ...tool,
        description: `${tool.description} Allowed MT5 symbols for this run: ${allowedLabel}.`,
        parameters: tool.parameters.superRefine((value, ctx) => {
            if (!isRecord(value) || typeof value[field] !== "string") {
                return
            }

            try {
                resolveMT5AllowedSymbol(value[field], normalizedAllowedSymbols)
            } catch (error) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: error instanceof Error ? error.message : String(error),
                    path: [field],
                })
            }
        }),
        jsonSchema: restrictJsonSchemaField(tool.jsonSchema, field, normalizedAllowedSymbols),
    }
}

function restrictJsonSchemaField(
    schema: Record<string, unknown> | undefined,
    field: "symbol" | "instrument",
    allowedSymbols: readonly string[]
): Record<string, unknown> | undefined {
    if (!schema) {
        return schema
    }

    const next = structuredClone(schema)
    if (!isRecord(next.properties)) {
        return next
    }

    const property = next.properties[field]
    if (!isRecord(property)) {
        return next
    }

    next.properties[field] = {
        ...property,
        enum: allowedSymbols,
        description: `${typeof property.description === "string" ? property.description : "MT5 symbol"} Allowed values: ${allowedSymbols.join(", ")}`,
    }
    return next
}

function normalizeAllowedSymbols(allowedSymbols: readonly string[]): string[] {
    return Array.from(new Set(
        allowedSymbols
            .map(normalizeMT5Symbol)
            .filter((symbol) => symbol.length > 0)
    )).sort((left, right) => left.localeCompare(right))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
