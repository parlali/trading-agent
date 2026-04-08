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

export interface ToolDefinition {
    name: string
    description: string
    parameters: z.ZodType<unknown>
    jsonSchema?: Record<string, unknown>
    handler: (params: unknown) => Promise<unknown>
    category?: ToolCategory
    compatibleVenues?: readonly VenueApp[]
}

export class ToolRegistry {
    private tools = new Map<string, ToolDefinition>()

    register(tool: ToolDefinition): void {
        this.tools.set(tool.name, tool)
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name)
    }

    getAll(): ToolDefinition[] {
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

    toOpenRouterTools(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
        return this.getAll().map((t) => ({
            type: "function" as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.jsonSchema ?? { type: "object", properties: {} },
            },
        }))
    }
}
