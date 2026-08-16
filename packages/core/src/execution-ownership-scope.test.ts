import { describe, expect, it } from "vitest"
import { ExecutionPipeline, type ExecutionPipelineConfig, type VenueAdapter } from "./execution.ts"
import { collectForeignProviderPositionKeys, type ProviderOwnershipScope } from "./position-filter.ts"
import { createLogger } from "./logger.ts"
import type { AccountState, OrderIntent, Position } from "./types.ts"

const testLogger = createLogger({ minLevel: "fatal" })

const providerAccount: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const entryIntent: OrderIntent = {
    instrument: "XAUUSD",
    side: "buy",
    quantity: 0.02,
    orderType: "market",
    timeInForce: "ioc",
}

function createOwnedPosition(): Position {
    return {
        instrument: "XAUUSD",
        providerPositionId: "1600791764",
        side: "short",
        quantity: 0.01,
        entryPrice: 3330,
        currentPrice: 3330,
        unrealizedPnl: 0,
    }
}

function createOtherStrategyPosition(): Position {
    return {
        instrument: "XAUUSD",
        providerPositionId: "9900000001",
        side: "long",
        quantity: 0.5,
        entryPrice: 3300,
        currentPrice: 3335,
        unrealizedPnl: 175,
    }
}

function createReenteredPosition(providerPositionId: string | undefined): Position {
    return {
        instrument: "XAUUSD",
        providerPositionId,
        side: "long",
        quantity: 0.02,
        entryPrice: 3335,
        currentPrice: 3340,
        unrealizedPnl: 12,
    }
}

function createProviderBook(positions: Position[]) {
    const book = [...positions]

    const venue: VenueAdapter = {
        getPositions: async () => [...book],
        getAccountState: async () => providerAccount,
        submitOrder: async () => ({
            orderId: "1830194334",
            providerOrderId: "1830194334",
            status: "filled",
            filledQuantity: entryIntent.quantity,
            fillPrice: 3335,
            timestamp: Date.now(),
        }),
        cancelOrder: async (orderId: string) => ({
            orderId,
            status: "cancelled",
            filledQuantity: 0,
            timestamp: Date.now(),
        }),
        modifyOrder: async (orderId: string) => ({
            orderId,
            status: "pending",
            filledQuantity: 0,
            timestamp: Date.now(),
        }),
        closePosition: async (instrument: string) => ({
            orderId: `close-${instrument}`,
            status: "filled",
            filledQuantity: 0.01,
            timestamp: Date.now(),
        }),
        closeProviderPosition: async (position: Position, intent: OrderIntent) => {
            const index = book.findIndex((candidate) =>
                candidate.providerPositionId === position.providerPositionId
            )
            if (index >= 0) {
                const remaining = position.quantity - intent.quantity
                if (remaining > 0) {
                    book[index] = { ...position, quantity: remaining }
                } else {
                    book.splice(index, 1)
                }
            }

            return {
                orderId: `close-${position.providerPositionId}`,
                status: "filled" as const,
                filledQuantity: intent.quantity,
                fillPrice: 3331,
                timestamp: Date.now(),
            }
        },
        getOrderStatus: async (orderId: string) => ({
            orderId,
            status: "filled",
            filledQuantity: entryIntent.quantity,
            timestamp: Date.now(),
        }),
    }

    return {
        venue,
        openPosition: (position: Position) => {
            book.push(position)
        },
    }
}

function createScope(overrides: Partial<ProviderOwnershipScope> = {}): ProviderOwnershipScope {
    return {
        instruments: new Set(["XAUUSD"]),
        positionKeys: new Set(["XAUUSD:1600791764"]),
        workingOrderIds: new Set<string>(),
        ...overrides,
    }
}

function createPipeline(
    venue: VenueAdapter,
    ownershipScope: ProviderOwnershipScope,
    config: Partial<ExecutionPipelineConfig> = {}
): ExecutionPipeline {
    return new ExecutionPipeline({
        venue,
        venueName: "mt5",
        policy: {
            dryRun: false,
            safety: {
                account: {
                    allocationPercent: 100,
                },
            },
        },
        logger: testLogger,
        runId: "run-1",
        strategyId: "strategy-1",
        ownedInstruments: ownershipScope.instruments,
        ownershipScope,
        ...config,
    })
}

describe("intra-run ownership scope tracking", () => {
    it("sees the replacement position after a close and re-entry inside one run", async () => {
        const closedPosition = createOwnedPosition()
        const reenteredPosition = createReenteredPosition("1830194335")
        const book = createProviderBook([closedPosition])
        const scope = createScope()
        const pipeline = createPipeline(book.venue, scope)

        await pipeline.closeProviderPosition(closedPosition, "flip")
        expect(scope.positionKeys.has("XAUUSD:1600791764")).toBe(false)

        book.openPosition(reenteredPosition)
        await pipeline.executeIntent(entryIntent, providerAccount, [])

        expect(await pipeline.getPositions()).toEqual([reenteredPosition])

        const accountState = await pipeline.getAccountState()
        expect(accountState.marginUsed).toBeCloseTo(0.02 * 3335, 6)
        expect(accountState.openPnl).toBe(12)
    })

    it("sees the replacement position when a stale key for the instrument survives the close", async () => {
        const closedPosition = createOwnedPosition()
        const reenteredPosition = createReenteredPosition("1830194335")
        const book = createProviderBook([closedPosition])
        const scope = createScope({
            positionKeys: new Set(["XAUUSD:1600791764", "XAUUSD:1600700000"]),
        })
        const pipeline = createPipeline(book.venue, scope)

        await pipeline.closeProviderPosition(closedPosition, "flip")
        book.openPosition(reenteredPosition)
        await pipeline.executeIntent(entryIntent, providerAccount, [])

        expect(await pipeline.getPositions()).toEqual([reenteredPosition])
    })

    it("keeps another strategy's position on the same instrument invisible after the flip", async () => {
        const closedPosition = createOwnedPosition()
        const otherStrategyPosition = createOtherStrategyPosition()
        const reenteredPosition = createReenteredPosition("1830194335")
        const book = createProviderBook([closedPosition, otherStrategyPosition])
        const scope = createScope()
        scope.foreignPositionKeys = collectForeignProviderPositionKeys(
            [closedPosition, otherStrategyPosition],
            [closedPosition]
        )
        const pipeline = createPipeline(book.venue, scope)

        await pipeline.closeProviderPosition(closedPosition, "flip")
        book.openPosition(reenteredPosition)
        await pipeline.executeIntent(entryIntent, providerAccount, [])

        expect(await pipeline.getPositions()).toEqual([reenteredPosition])
    })

    it("scopes the replacement position by exact key when the entry result carries a provider position id", async () => {
        const closedPosition = createOwnedPosition()
        const reenteredPosition = createReenteredPosition("1830194335")
        const book = createProviderBook([closedPosition])
        const scope = createScope({
            positionKeys: new Set(["XAUUSD:1600791764", "XAUUSD:1600700000"]),
        })
        const pipeline = createPipeline({
            ...book.venue,
            submitOrder: async () => ({
                orderId: "1830194334",
                providerOrderId: "1830194334",
                status: "filled",
                filledQuantity: entryIntent.quantity,
                fillPrice: 3335,
                timestamp: Date.now(),
                intentUpdates: {
                    metadata: {
                        providerPositionId: "1830194335",
                    },
                },
            }),
        }, scope)

        await pipeline.closeProviderPosition(closedPosition, "flip")
        book.openPosition(reenteredPosition)
        await pipeline.executeIntent(entryIntent, providerAccount, [])

        expect(scope.positionKeys.has("XAUUSD:1830194335")).toBe(true)
        expect(scope.instrumentFallbackUnlocks).toBeUndefined()
        expect(await pipeline.getPositions()).toEqual([reenteredPosition])
    })

    it("leaves the ownership scope untouched when the run does not flip a position", async () => {
        const ownedPosition = createOwnedPosition()
        const book = createProviderBook([ownedPosition])
        const scope = createScope()
        const pipeline = createPipeline(book.venue, scope)

        expect(await pipeline.getPositions()).toEqual([ownedPosition])
        expect(scope.positionKeys).toEqual(new Set(["XAUUSD:1600791764"]))
        expect(scope.instrumentFallbackUnlocks).toBeUndefined()
    })

    it("keeps a partially closed position owned", async () => {
        const ownedPosition = createOwnedPosition()
        const book = createProviderBook([ownedPosition])
        const scope = createScope()
        const pipeline = createPipeline(book.venue, scope)

        await pipeline.closeProviderPosition(ownedPosition, "partial", { quantity: 0.004 })

        expect(scope.positionKeys.has("XAUUSD:1600791764")).toBe(true)
    })
})
