import { describe, expect, it } from "vitest"
import {
    getToolContract,
    listToolContracts,
} from "./tool-contracts.ts"

const unsupportedTopLevelSchemaKeys = [
    "oneOf",
    "anyOf",
    "allOf",
    "enum",
    "not",
] as const

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

    it("normalizes malformed boolean search strings before venue lookup", () => {
        const searchMarkets = getToolContract("search_markets", "polymarket")

        const result = searchMarkets.parameters.safeParse({
            query: "(Trump and election) OR (Fed not rates)",
            limit: 5,
        })

        expect(result.success).toBe(true)
        expect(result.data).toMatchObject({
            query: "Trump election Fed rates",
        })
    })

    it("keeps every cataloged tool schema OpenRouter-compatible", () => {
        for (const contract of listToolContracts()) {
            for (const key of unsupportedTopLevelSchemaKeys) {
                expect(contract.jsonSchema).not.toHaveProperty(key)
            }
        }
    })
})
