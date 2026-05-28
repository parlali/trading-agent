import { describe, expect, it } from "vitest"
import { getToolContract } from "./tool-contracts.ts"

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
            query: "(Alpha and beta) OR (Gamma not delta)",
            limit: 5,
        })

        expect(result.success).toBe(true)
        expect(result.data).toMatchObject({
            query: "Alpha beta Gamma delta",
        })
    })

})
