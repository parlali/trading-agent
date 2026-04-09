import type { Logger, VenueApp } from "@valiq-trading/core";
import type { ToolCategory, ToolDefinition } from "./tool-registry";
export interface ToolFactoryRegistration {
    name: string;
    category: ToolCategory;
    compatibleVenues: readonly VenueApp[];
    create: () => ToolDefinition | ToolDefinition[] | null | undefined;
}
export interface ToolRegistration {
    tool: ToolDefinition;
    category: ToolCategory;
    compatibleVenues: readonly VenueApp[];
}
interface ToolPoolOptions {
    logger?: Pick<Logger, "warn">;
}
export declare class ToolPool {
    private readonly options;
    private readonly entries;
    constructor(options?: ToolPoolOptions);
    registerFactory(registration: ToolFactoryRegistration): void;
    registerTool(registration: ToolRegistration): void;
    forVenue(venue: VenueApp): ToolDefinition[];
    private decorateTool;
}
export {};
//# sourceMappingURL=tool-pool.d.ts.map