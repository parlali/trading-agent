import { z } from "zod"
import {
    resolveMT5AllowedSymbol,
    resolveMT5AllowedSymbols,
} from "@valiq-trading/mt5"
import type { ToolBinding } from "../tool-registry"

export function withMT5SymbolAllowList(
    tool: ToolBinding,
    field: "symbol" | "instrument",
    allowedSymbols: readonly string[]
): ToolBinding {
    const resolvedAllowedSymbols = resolveMT5AllowedSymbols(allowedSymbols)
    const allowedLabel = resolvedAllowedSymbols.length > 0
        ? resolvedAllowedSymbols.join(", ")
        : "none"

    return {
        ...tool,
        description: `${tool.description} Allowed MT5 symbols for this run: ${allowedLabel}.`,
        parameters: tool.parameters.superRefine((value, ctx) => {
            if (!isRecord(value) || typeof value[field] !== "string") {
                return
            }

            try {
                resolveMT5AllowedSymbol(value[field], resolvedAllowedSymbols)
            } catch (error) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: error instanceof Error ? error.message : String(error),
                    path: [field],
                })
            }
        }),
        jsonSchema: restrictJsonSchemaField(tool.jsonSchema, field, resolvedAllowedSymbols),
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
