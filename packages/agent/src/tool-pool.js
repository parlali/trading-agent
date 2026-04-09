export class ToolPool {
    options;
    entries = [];
    constructor(options = {}) {
        this.options = options;
    }
    registerFactory(registration) {
        this.entries.push(registration);
    }
    registerTool(registration) {
        if (registration.tool.category &&
            registration.tool.category !== registration.category) {
            this.options.logger?.warn("Tool category mismatch detected during registration", {
                tool: registration.tool.name,
                declaredCategory: registration.tool.category,
                registeredCategory: registration.category,
            });
        }
        if (registration.tool.compatibleVenues &&
            registration.compatibleVenues.some((venue) => !registration.tool.compatibleVenues?.includes(venue))) {
            this.options.logger?.warn("Tool registered for incompatible venue set", {
                tool: registration.tool.name,
                registeredVenues: [...registration.compatibleVenues],
                designedVenues: [...registration.tool.compatibleVenues],
            });
        }
        this.entries.push(registration);
    }
    forVenue(venue) {
        const tools = [];
        const seenNames = new Set();
        for (const entry of this.entries) {
            if (!entry.compatibleVenues.includes(venue)) {
                continue;
            }
            const resolved = "tool" in entry
                ? [entry.tool]
                : toToolArray(entry.create());
            for (const tool of resolved) {
                if (!("tool" in entry) && tool.name !== entry.name) {
                    throw new Error(`Tool factory for ${entry.name} produced unexpected tool ${tool.name} for venue ${venue}`);
                }
                const decoratedTool = this.decorateTool(tool, entry.category, entry.compatibleVenues, venue);
                if (seenNames.has(decoratedTool.name)) {
                    throw new Error(`Duplicate tool registration detected for ${decoratedTool.name} on venue ${venue}`);
                }
                seenNames.add(decoratedTool.name);
                tools.push(decoratedTool);
            }
        }
        return tools;
    }
    decorateTool(tool, category, compatibleVenues, venue) {
        if (tool.category && tool.category !== category) {
            this.options.logger?.warn("Tool category mismatch detected during registration", {
                tool: tool.name,
                declaredCategory: tool.category,
                registeredCategory: category,
                venue,
            });
        }
        if (tool.compatibleVenues && !tool.compatibleVenues.includes(venue)) {
            this.options.logger?.warn("Tool registered for incompatible venue", {
                tool: tool.name,
                venue,
                designedVenues: [...tool.compatibleVenues],
            });
        }
        return {
            ...tool,
            category,
            compatibleVenues: [...compatibleVenues],
        };
    }
}
function toToolArray(tool) {
    if (!tool) {
        return [];
    }
    return Array.isArray(tool) ? tool : [tool];
}
