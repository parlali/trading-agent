import type { Logger, VenueApp } from "@valiq-trading/core"
import type { ToolCategory, ToolDefinition } from "./tool-registry"

export interface ToolFactoryRegistration {
    name: string
    category: ToolCategory
    compatibleVenues: readonly VenueApp[]
    create: () => ToolDefinition | ToolDefinition[] | null | undefined
}

export interface ToolRegistration {
    tool: ToolDefinition
    category: ToolCategory
    compatibleVenues: readonly VenueApp[]
}

type ToolPoolEntry = ToolFactoryRegistration | ToolRegistration

interface ToolPoolOptions {
    logger?: Pick<Logger, "warn">
}

export class ToolPool {
    private readonly entries: ToolPoolEntry[] = []

    constructor(private readonly options: ToolPoolOptions = {}) {}

    registerFactory(registration: ToolFactoryRegistration): void {
        this.entries.push(registration)
    }

    registerTool(registration: ToolRegistration): void {
        if (
            registration.tool.category &&
            registration.tool.category !== registration.category
        ) {
            this.options.logger?.warn("Tool category mismatch detected during registration", {
                tool: registration.tool.name,
                declaredCategory: registration.tool.category,
                registeredCategory: registration.category,
            })
        }

        if (
            registration.tool.compatibleVenues &&
            registration.compatibleVenues.some((venue) =>
                !registration.tool.compatibleVenues?.includes(venue)
            )
        ) {
            this.options.logger?.warn("Tool registered for incompatible venue set", {
                tool: registration.tool.name,
                registeredVenues: [...registration.compatibleVenues],
                designedVenues: [...registration.tool.compatibleVenues],
            })
        }

        this.entries.push(registration)
    }

    forVenue(venue: VenueApp): ToolDefinition[] {
        const tools: ToolDefinition[] = []
        const seenNames = new Set<string>()

        for (const entry of this.entries) {
            if (!entry.compatibleVenues.includes(venue)) {
                continue
            }

            const resolved = "tool" in entry
                ? [entry.tool]
                : toToolArray(entry.create())

            for (const tool of resolved) {
                if (!("tool" in entry) && tool.name !== entry.name) {
                    this.options.logger?.warn("Tool factory produced an unexpected tool name", {
                        expectedTool: entry.name,
                        actualTool: tool.name,
                        venue,
                    })
                }

                const decoratedTool = this.decorateTool(
                    tool,
                    entry.category,
                    entry.compatibleVenues,
                    venue
                )

                if (seenNames.has(decoratedTool.name)) {
                    this.options.logger?.warn("Duplicate tool registration detected for venue", {
                        venue,
                        tool: decoratedTool.name,
                    })
                }

                seenNames.add(decoratedTool.name)
                tools.push(decoratedTool)
            }
        }

        return tools
    }

    private decorateTool(
        tool: ToolDefinition,
        category: ToolCategory,
        compatibleVenues: readonly VenueApp[],
        venue: VenueApp
    ): ToolDefinition {
        if (tool.category && tool.category !== category) {
            this.options.logger?.warn("Tool category mismatch detected during registration", {
                tool: tool.name,
                declaredCategory: tool.category,
                registeredCategory: category,
                venue,
            })
        }

        if (tool.compatibleVenues && !tool.compatibleVenues.includes(venue)) {
            this.options.logger?.warn("Tool registered for incompatible venue", {
                tool: tool.name,
                venue,
                designedVenues: [...tool.compatibleVenues],
            })
        }

        return {
            ...tool,
            category,
            compatibleVenues: [...compatibleVenues],
        }
    }
}

function toToolArray(
    tool: ToolDefinition | ToolDefinition[] | null | undefined
): ToolDefinition[] {
    if (!tool) {
        return []
    }

    return Array.isArray(tool) ? tool : [tool]
}
