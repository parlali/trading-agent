import { describe, expect, it, vi } from "vitest"
import type { ExecutionPipeline, Position } from "@valiq-trading/core"
import { createPolymarketProposeOrderTool } from "./propose-order-polymarket"
import type { PolymarketPriceProvider } from "./polymarket-order-helpers"

describe("createPolymarketProposeOrderTool", () => {
    it("routes same-side additions to an already-held token as adjustments", async () => {
        const tokenId = "123456789012345678901234567890"
        const conditionId = "condition-add-token"
        const pipeline = createPipeline([
            createPosition({
                instrument: tokenId,
                conditionId,
                quantity: 25,
            }),
        ])
        const venue = createVenue()
        const tool = createPolymarketProposeOrderTool(pipeline, venue)

        const result = await tool.handler(createParams({
            tokenId,
            conditionId,
        }))

        expect(result).toMatchObject({ status: "filled" })
        const executeIntent = pipeline.executeIntent as ReturnType<typeof vi.fn>
        expect(executeIntent.mock.calls[0]?.[3]).toMatchObject({ action: "adjustment" })
    })

    it("rejects another outcome from an already-held condition before live price lookup", async () => {
        const heldTokenId = "223456789012345678901234567890"
        const candidateTokenId = "323456789012345678901234567890"
        const conditionId = "condition-duplicate-market"
        const pipeline = createPipeline([
            createPosition({
                instrument: heldTokenId,
                conditionId,
                quantity: 30,
            }),
        ])
        const venue = createVenue()
        const tool = createPolymarketProposeOrderTool(pipeline, venue)

        const result = await tool.handler(createParams({
            tokenId: candidateTokenId,
            conditionId,
        }))

        expect(result).toMatchObject({
            status: "rejected",
            errorDetail: {
                code: "POLYMARKET_DUPLICATE_MARKET",
            },
            riskValidation: {
                allowed: false,
            },
        })
        expect(venue.getMarketPrice).not.toHaveBeenCalled()
    })
})

function createPipeline(positions: Position[]): ExecutionPipeline {
    return {
        getPositions: vi.fn(async () => positions),
        getAccountState: vi.fn(async () => ({
            balance: 1000,
            equity: 1000,
            buyingPower: 1000,
            marginUsed: 0,
            marginAvailable: 1000,
            openPnl: 0,
            dayPnl: 0,
        })),
        executeIntent: vi.fn(async () => ({
            result: {
                orderId: "order-add-1",
                status: "filled",
                filledQuantity: 10,
                fillPrice: 0.5,
                timestamp: Date.now(),
            },
            validation: { allowed: true },
        })),
    } as unknown as ExecutionPipeline
}

function createVenue(): PolymarketPriceProvider & {
    getMarketPrice: ReturnType<typeof vi.fn>
} {
    return {
        getMarketPrice: vi.fn(async () => ({
            midpoint: 0.5,
            executablePrice: 0.5,
        })),
    } as unknown as PolymarketPriceProvider & {
        getMarketPrice: ReturnType<typeof vi.fn>
    }
}

function createPosition(args: {
    instrument: string
    conditionId: string
    quantity: number
}): Position {
    return {
        instrument: args.instrument,
        side: "long",
        quantity: args.quantity,
        entryPrice: 0.49,
        metadata: {
            tokenId: args.instrument,
            conditionId: args.conditionId,
        },
    }
}

function createParams(args: {
    tokenId: string
    conditionId: string
}) {
    return {
        tokenId: args.tokenId,
        conditionId: args.conditionId,
        marketSlug: "duplicate-market",
        question: "Will this duplicate market be blocked?",
        outcome: "Yes",
        side: "buy",
        quantity: 10,
        orderType: "limit",
        limitPrice: 0.5,
        timeInForce: "gtc",
    }
}
