import type { VenueApp } from "@valiq-trading/core"
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
}

export function assertToolNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const error = new Error("Tool execution cancelled")
        error.name = "AbortError"
        throw error
    }
}
