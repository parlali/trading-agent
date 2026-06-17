import {
    sha256Hex,
    stableJsonKey,
    type VenueApp,
} from "@valiq-trading/core"
import type { z } from "zod"

export const TOOL_CATEGORIES = [
    "execution",
    "account",
    "market-data",
    "research",
    "web",
] as const

export type ToolCategory = typeof TOOL_CATEGORIES[number]

export interface ToolHandlerContext {
    signal?: AbortSignal
}

export interface ToolBinding {
    name: string
    description: string
    parameters: z.ZodType<unknown>
    jsonSchema?: Record<string, unknown>
    outputDescription?: string
    errorSemantics?: string
    contractBoundary?: "shared" | "venue-owned"
    contractOwner?: string
    handler: (params: unknown, context?: ToolHandlerContext) => Promise<unknown>
    category?: ToolCategory
    compatibleVenues?: readonly VenueApp[]
}

export interface ToolManifestEntry {
    name: string
    schemaHash: string
    category?: ToolCategory
    contractBoundary?: ToolBinding["contractBoundary"]
    contractOwner?: string
}

export class ToolRegistry {
    private tools = new Map<string, ToolBinding>()

    register(tool: ToolBinding): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Duplicate tool registration detected for ${tool.name}`)
        }

        this.tools.set(tool.name, tool)
    }

    get(name: string): ToolBinding | undefined {
        return this.tools.get(name)
    }

    getAll(): ToolBinding[] {
        return Array.from(this.tools.values())
    }

    has(name: string): boolean {
        return this.tools.has(name)
    }

    getDescriptions(): Array<{ name: string; description: string }> {
        return this.getAll().map((t) => ({
            name: t.name,
            description: t.description,
        }))
    }

    getManifest(): ToolManifestEntry[] {
        return this.getAll().map((tool) => ({
            name: tool.name,
            schemaHash: hashToolBindingSchema(tool),
            category: tool.category,
            contractBoundary: tool.contractBoundary,
            contractOwner: tool.contractOwner,
        }))
    }
}

export function hashToolBindingSchema(tool: Pick<ToolBinding, "name" | "jsonSchema">): string {
    const schema = tool.jsonSchema ?? {
        name: tool.name,
        input: "zod-runtime-schema",
    }

    return sha256Hex(stableJsonKey(schema))
}

export function assertToolNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createToolAbortError()
    }
}

export function createToolAbortError(): Error {
    const error = new Error("Tool execution cancelled")
    error.name = "AbortError"
    return error
}
