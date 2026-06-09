import type { ToolBinding } from "../tool-registry"

export interface McpToolProjection {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    outputDescription?: string
    annotations?: {
        readOnlyHint?: boolean
        destructiveHint?: boolean
    }
}

export function projectToolForMcp(binding: ToolBinding): McpToolProjection {
    return {
        name: binding.name,
        description: binding.description,
        inputSchema: binding.jsonSchema ?? { type: "object", properties: {} },
        outputDescription: binding.outputDescription,
        annotations: {
            readOnlyHint: binding.category !== "execution",
            destructiveHint: binding.category === "execution",
        },
    }
}

export function projectToolsForMcp(bindings: ToolBinding[]): McpToolProjection[] {
    return bindings.map(projectToolForMcp)
}
