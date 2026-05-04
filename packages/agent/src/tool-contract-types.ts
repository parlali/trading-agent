import { z } from "zod"
import type { VenueApp } from "@valiq-trading/core"
import type { ToolCategory } from "./tool-registry"

export type ToolContractBoundary = "shared" | "venue-owned"

export interface ToolContractVariant {
    description: string
    parameters: z.ZodTypeAny
    jsonSchema: Record<string, unknown>
    outputDescription: string
    errorSemantics: string
}

export interface ToolContractDefinition {
    name: string
    category: ToolCategory
    boundary: ToolContractBoundary
    owner: string
    compatibleVenues: readonly VenueApp[]
    defaultVariant?: ToolContractVariant
    variants?: Partial<Record<VenueApp, ToolContractVariant>>
}

export interface ResolvedToolContract extends ToolContractVariant {
    name: string
    category: ToolCategory
    boundary: ToolContractBoundary
    owner: string
    compatibleVenues: readonly VenueApp[]
}
