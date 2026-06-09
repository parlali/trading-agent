import type { VenueApp } from "@valiq-trading/core"
import type { ToolBinding } from "./tool-registry"
import { toolContractDefinitions } from "./tool-contract-catalog-data"
import type {
    ResolvedToolContract,
    ToolContractBoundary,
    ToolContractDefinition,
    ToolContractVariant,
} from "./tool-contract-types"

export type {
    ResolvedToolContract,
    ToolContractBoundary,
    ToolContractDefinition,
    ToolContractVariant,
} from "./tool-contract-types"

export {
    alpacaLegSchema,
    alpacaModifyOrderJsonSchema,
    alpacaModifyOrderParamsSchema,
    alpacaOrderJsonSchema,
    alpacaOrderParamsSchema,
    closeJsonSchema,
    closeParamsSchema,
    defaultModifyOrderJsonSchema,
    defaultModifyOrderParamsSchema,
    emptyParamsSchema,
    genericAdjustmentJsonSchema,
    genericAdjustmentParamsSchema,
    genericLegSchema,
    genericOrderJsonSchema,
    genericOrderParamsSchema,
    mt5ModifyOrderJsonSchema,
    mt5ModifyOrderParamsSchema,
    okxAdjustmentJsonSchema,
    okxAdjustmentParamsSchema,
    orderIdParamsSchema,
    orderIdWithReasonParamsSchema,
    polymarketOrderJsonSchema,
    polymarketOrderParamsSchema,
    waitForOrderUpdateParamsSchema,
} from "./tool-contract-execution-schemas"

export {
    getOptionsChainJsonSchema,
    getOptionsChainParamsSchema,
    getQuoteJsonSchema,
    getSymbolInfoJsonSchema,
    okxMarketPriceJsonSchema,
    okxOrderBookJsonSchema,
    okxOrderBookParamsSchema,
    polymarketMarketPriceJsonSchema,
    polymarketMarketPriceParamsSchema,
    polymarketOrderBookJsonSchema,
    polymarketOrderBookParamsSchema,
    searchMarketsJsonSchema,
    searchMarketsParamsSchema,
    singleSymbolParamsSchema,
    webFetchJsonSchema,
    webFetchParamsSchema,
    webSearchJsonSchema,
    webSearchParamsSchema,
} from "./tool-contract-market-data-schemas"

const toolContracts = createToolContractCatalog(toolContractDefinitions)

export function createToolContractCatalog(
    contracts: readonly ToolContractDefinition[]
): Map<string, ToolContractDefinition> {
    const catalog = new Map<string, ToolContractDefinition>()

    for (const contract of contracts) {
        if (catalog.has(contract.name)) {
            throw new Error(`Duplicate tool contract definition detected for ${contract.name}`)
        }

        const variantVenues = Object.keys(contract.variants ?? {}) as VenueApp[]
        for (const venue of variantVenues) {
            if (!contract.compatibleVenues.includes(venue)) {
                throw new Error(`Tool contract ${contract.name} defines unsupported venue variant ${venue}`)
            }
        }

        if (!contract.defaultVariant) {
            for (const venue of contract.compatibleVenues) {
                if (!contract.variants?.[venue]) {
                    throw new Error(`Tool contract ${contract.name} is missing a variant for ${venue}`)
                }
            }
        }

        catalog.set(contract.name, contract)
    }

    return catalog
}

export function getToolContract(
    name: string,
    venue?: VenueApp
): ResolvedToolContract {
    const contract = toolContracts.get(name)
    if (!contract) {
        throw new Error(`Unknown tool contract: ${name}`)
    }

    if (venue && !contract.compatibleVenues.includes(venue)) {
        throw new Error(`Tool ${name} is not compatible with venue ${venue}`)
    }

    const variant = venue
        ? contract.variants?.[venue] ?? contract.defaultVariant
        : contract.defaultVariant ?? firstVariant(contract)

    if (!variant) {
        throw new Error(`Tool contract ${name} has no resolvable variant`)
    }

    return {
        name: contract.name,
        category: contract.category,
        boundary: contract.boundary,
        owner: contract.owner,
        compatibleVenues: contract.compatibleVenues,
        description: variant.description,
        parameters: variant.parameters,
        jsonSchema: variant.jsonSchema,
        outputDescription: variant.outputDescription,
        errorSemantics: variant.errorSemantics,
    }
}

export function getToolCategory(name: string) {
    return getToolContract(name).category
}

export function getToolBoundary(name: string): ToolContractBoundary {
    return getToolContract(name).boundary
}

export function listToolContracts(): ResolvedToolContract[] {
    return Array.from(toolContracts.keys()).map((name) => getToolContract(name))
}

export function createToolBinding(config: {
    name: string
    venue?: VenueApp
    handler: ToolBinding["handler"]
}): ToolBinding {
    const contract = getToolContract(config.name, config.venue)

    return {
        name: contract.name,
        description: contract.description,
        parameters: contract.parameters,
        jsonSchema: contract.jsonSchema,
        category: contract.category,
        compatibleVenues: contract.compatibleVenues,
        contractBoundary: contract.boundary,
        contractOwner: contract.owner,
        outputDescription: contract.outputDescription,
        errorSemantics: contract.errorSemantics,
        handler: config.handler,
    }
}

function firstVariant(
    contract: ToolContractDefinition
): ToolContractVariant | undefined {
    if (!contract.variants) {
        return undefined
    }

    for (const venue of contract.compatibleVenues) {
        const variant = contract.variants[venue]
        if (variant) {
            return variant
        }
    }

    return undefined
}
