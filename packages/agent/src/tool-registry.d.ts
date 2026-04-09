import type { VenueApp } from "@valiq-trading/core";
import type { z } from "zod";
export declare const TOOL_CATEGORIES: readonly ["execution", "account", "market-data", "research", "web"];
export type ToolCategory = typeof TOOL_CATEGORIES[number];
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: z.ZodType<unknown>;
    jsonSchema?: Record<string, unknown>;
    outputDescription?: string;
    errorSemantics?: string;
    contractBoundary?: "shared" | "venue-owned";
    contractOwner?: string;
    handler: (params: unknown) => Promise<unknown>;
    category?: ToolCategory;
    compatibleVenues?: readonly VenueApp[];
}
export declare class ToolRegistry {
    private tools;
    register(tool: ToolDefinition): void;
    get(name: string): ToolDefinition | undefined;
    getAll(): ToolDefinition[];
    has(name: string): boolean;
    getDescriptions(): Array<{
        name: string;
        description: string;
    }>;
    toOpenRouterTools(): Array<{
        type: "function";
        function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        };
    }>;
}
//# sourceMappingURL=tool-registry.d.ts.map