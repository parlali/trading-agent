import type { OpenRouterTool } from "../providers/openrouter/openrouter-chat-client"
import type { ToolBinding } from "../tool-registry"

const OPENROUTER_UNSUPPORTED_TOP_LEVEL_JSON_SCHEMA_KEYS = [
    "oneOf",
    "anyOf",
    "allOf",
    "enum",
    "not",
] as const

export function projectToolForOpenRouter(binding: ToolBinding): OpenRouterTool {
    const schema = binding.jsonSchema ?? { type: "object", properties: {} }
    validateOpenRouterToolJsonSchema(schema, binding.name)

    return {
        type: "function",
        function: {
            name: binding.name,
            description: binding.description,
            parameters: schema,
        },
    }
}

export function projectToolsForOpenRouter(bindings: ToolBinding[]): OpenRouterTool[] {
    return bindings.map(projectToolForOpenRouter)
}

export function validateOpenRouterToolJsonSchema(
    schema: Record<string, unknown>,
    label: string
): void {
    for (const key of OPENROUTER_UNSUPPORTED_TOP_LEVEL_JSON_SCHEMA_KEYS) {
        if (key in schema) {
            throw new Error(
                `Tool schema ${label} uses unsupported top-level JSON Schema keyword ${key}`
            )
        }
    }
}
