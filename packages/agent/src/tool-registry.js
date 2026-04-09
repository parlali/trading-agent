export const TOOL_CATEGORIES = [
    "execution",
    "account",
    "market-data",
    "research",
    "web",
];
export class ToolRegistry {
    tools = new Map();
    register(tool) {
        if (this.tools.has(tool.name)) {
            throw new Error(`Duplicate tool registration detected for ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    }
    get(name) {
        return this.tools.get(name);
    }
    getAll() {
        return Array.from(this.tools.values());
    }
    has(name) {
        return this.tools.has(name);
    }
    getDescriptions() {
        return this.getAll().map((t) => ({
            name: t.name,
            description: t.description,
        }));
    }
    toOpenRouterTools() {
        return this.getAll().map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.jsonSchema ?? { type: "object", properties: {} },
            },
        }));
    }
}
