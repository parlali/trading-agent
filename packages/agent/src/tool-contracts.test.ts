import { describe, expect, it } from "vitest"
import { z } from "zod"
import { toolContractDefinitions } from "./tool-contract-catalog-data.ts"
import { createToolBinding, getToolContract, listToolContracts } from "./tool-contracts.ts"
import { projectToolForMcp } from "./tool-projections/mcp.ts"
import { projectToolForOpenRouter } from "./tool-projections/openrouter.ts"
import { ToolRegistry } from "./tool-registry.ts"

describe("tool contracts", () => {
    it("rejects truncated Polymarket token IDs while accepting run-local handles", () => {
        const polymarketOrder = getToolContract("propose_order", "polymarket")

        expect(polymarketOrder.parameters.safeParse({
            tokenHandle: "pm_00abcdef",
            marketSlug: "market-slug",
            question: "Will it happen?",
            outcome: "Yes",
            side: "buy",
            quantity: 10,
            orderType: "limit",
            limitPrice: 0.5,
        }).success).toBe(true)
        expect(polymarketOrder.parameters.safeParse({
            tokenId: "425888",
            conditionId: "condition",
            marketSlug: "market-slug",
            question: "Will it happen?",
            outcome: "Yes",
            side: "buy",
            quantity: 10,
            orderType: "limit",
            limitPrice: 0.5,
        }).success).toBe(false)
    })

    it("requires structure-specific short-strike deltas on Alpaca credit entries", () => {
        const alpacaOrder = getToolContract("propose_order", "alpaca-options")
        const verticalLegs = [
            { instrument: "SPY260805P00700000", side: "sell_to_open", quantity: 1 },
            { instrument: "SPY260805P00699000", side: "buy_to_open", quantity: 1 },
        ]
        const condorLegs = [
            ...verticalLegs,
            { instrument: "SPY260805C00760000", side: "sell_to_open", quantity: 1 },
            { instrument: "SPY260805C00761000", side: "buy_to_open", quantity: 1 },
        ]
        const baseProposal = {
            instrument: "VS:BULL_PUT_CREDIT:SPY:2026-08-05:SPY260805P00699000|SPY260805P00700000",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 0.3,
            timeInForce: "day",
        }

        expect(alpacaOrder.parameters.safeParse({
            ...baseProposal,
            legs: verticalLegs,
        }).success).toBe(false)
        expect(alpacaOrder.parameters.safeParse({
            ...baseProposal,
            legs: verticalLegs,
            shortStrikeDelta: -0.18,
        }).success).toBe(true)
        expect(alpacaOrder.parameters.safeParse({
            ...baseProposal,
            legs: condorLegs,
            shortStrikeDelta: -0.18,
        }).success).toBe(false)
        expect(alpacaOrder.parameters.safeParse({
            ...baseProposal,
            legs: condorLegs,
            shortCallDelta: 0.17,
            shortPutDelta: -0.18,
        }).success).toBe(true)
    })

    it("normalizes malformed boolean search strings before venue lookup", () => {
        const searchMarkets = getToolContract("search_markets", "polymarket")

        const result = searchMarkets.parameters.safeParse({
            query: "(Alpha and beta) OR (Gamma not delta)",
            limit: 5,
        })

        expect(result.success).toBe(true)
        expect(result.data).toMatchObject({
            query: "Alpha beta Gamma delta",
        })
    })

    it("clamps live price token limit from production payload", () => {
        const searchMarkets = getToolContract("search_markets", "polymarket")

        const result = searchMarkets.parameters.safeParse({
            category: "politics",
            limit: 20,
            includeLivePrices: true,
            livePriceTokenLimit: 40,
        })

        expect(result.success).toBe(true)
        expect(result.data).toMatchObject({
            livePriceTokenLimit: 25,
        })
    })

    it("clamps order book levels from production payload", () => {
        const orderBook = getToolContract("get_order_book", "polymarket")

        const result = orderBook.parameters.safeParse({
            tokenHandle: "pm_00abcdef",
            levels: 100,
        })

        expect(result.success).toBe(true)
        expect(result.data).toMatchObject({
            levels: 50,
        })
    })

    it("does not advertise Alpaca propose_adjustment when venue risk rules reject that lifecycle", () => {
        expect(() => getToolContract("propose_adjustment", "alpaca-options")).toThrow(
            "Tool propose_adjustment is not compatible with venue alpaca-options"
        )
    })

    it("does not advertise unsupported Polymarket adjustment or modify lifecycles", () => {
        expect(() => getToolContract("propose_adjustment", "polymarket")).toThrow(
            "Tool propose_adjustment is not compatible with venue polymarket"
        )
        expect(() => getToolContract("modify_order", "polymarket")).toThrow(
            "Tool modify_order is not compatible with venue polymarket"
        )
    })

    it("defines required canonical metadata for every tool variant", () => {
        for (const contract of toolContractDefinitions) {
            expect(contract.name.length).toBeGreaterThan(0)
            expect(contract.category.length).toBeGreaterThan(0)
            expect(contract.compatibleVenues.length).toBeGreaterThan(0)

            const variants = contract.defaultVariant
                ? [contract.defaultVariant]
                : Object.values(contract.variants ?? {})

            expect(variants.length).toBeGreaterThan(0)
            for (const variant of variants) {
                expect(variant.description.length).toBeGreaterThan(0)
                expect(variant.parameters).toBeDefined()
                expect(variant.jsonSchema).toEqual(expect.any(Object))
                expect(variant.outputDescription?.length).toBeGreaterThan(0)
                expect(variant.errorSemantics?.length).toBeGreaterThan(0)
            }
        }
    })

    it("projects canonical contracts to OpenRouter and MCP without changing the source contract", () => {
        const contract = getToolContract("get_positions", "polymarket")
        const binding = createToolBinding({
            name: "get_positions",
            venue: "polymarket",
            handler: async () => ({ positions: [] }),
        })
        const before = structuredClone(contract.jsonSchema)

        expect(projectToolForOpenRouter(binding)).toMatchObject({
            type: "function",
            function: {
                name: "get_positions",
            },
        })
        expect(projectToolForMcp(binding)).toMatchObject({
            name: "get_positions",
            inputSchema: before,
        })
        expect(contract.jsonSchema).toEqual(before)
    })

    it("projects every canonical tool contract to OpenRouter and MCP", () => {
        const bindings = listToolContracts().map((contract) => ({
            ...contract,
            handler: async () => ({}),
        }))
        const openRouterTools = bindings.map((binding) => projectToolForOpenRouter(binding))
        const mcpTools = bindings.map((binding) => projectToolForMcp(binding))
        const contractNames = listToolContracts().map((contract) => contract.name).sort()

        expect(openRouterTools.map((tool) => tool.function.name).sort()).toEqual(contractNames)
        expect(mcpTools.map((tool) => tool.name).sort()).toEqual(contractNames)
    })

    it("persists deterministic schema hashes in tool manifests", () => {
        const registry = new ToolRegistry()
        registry.register(createToolBinding({
            name: "get_positions",
            venue: "polymarket",
            handler: async () => ({ positions: [] }),
        }))

        const manifest = registry.getManifest()

        expect(manifest).toEqual([expect.objectContaining({
            name: "get_positions",
            schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        })])
        expect(registry.getManifest()[0]?.schemaHash).toBe(manifest[0]?.schemaHash)
    })

    it("rejects OpenRouter-incompatible projection schemas without rejecting canonical contracts", () => {
        const binding = {
            name: "bad_schema",
            description: "Bad OpenRouter schema",
            parameters: z.object({}),
            jsonSchema: {
                oneOf: [],
            },
            handler: async () => ({}),
        }

        expect(projectToolForMcp(binding).inputSchema).toEqual({ oneOf: [] })
        expect(() => projectToolForOpenRouter(binding)).toThrow("unsupported top-level JSON Schema keyword oneOf")
    })
})
