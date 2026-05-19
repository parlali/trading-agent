import {
    createExecutionError,
    createChildExecutionIdentity,
    type ExecutionIdentityContext,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import type {
    OKXAlgoOrder,
    OKXApiPosSide,
    OKXAttachedAlgoOrderParams,
    OKXClient,
    OKXMarginMode,
    OKXPlaceAlgoOrderParams,
} from "./okx-client"
import {
    formatContracts,
    formatNumber,
    isCloseAction,
    readFiniteMetadataNumber,
    toCompositeOrderId,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

export function buildOKXProtectionKey(
    instId: string,
    posSide: string | undefined
): string {
    return `${instId}:${posSide ?? "net"}`
}

export function matchesOKXPositionProtection(
    order: OKXAlgoOrder,
    side: Position["side"],
    resolvePositionPosSide: (side: Position["side"]) => OKXApiPosSide
): boolean {
    return buildOKXProtectionKey(order.instId, order.posSide) === buildOKXProtectionKey(
        order.instId,
        resolvePositionPosSide(side)
    )
}

export async function buildOKXAttachedProtectionOrders(args: {
    instId: string
    intent: OrderIntent
    identity?: ExecutionIdentityContext
    normalizePrice: (price: number) => Promise<number>
}): Promise<OKXAttachedAlgoOrderParams[] | undefined> {
    if (isCloseAction(args.intent)) {
        return undefined
    }

    const stopLoss = readFiniteMetadataNumber(args.intent.metadata, "stopLoss")
    const takeProfit = readFiniteMetadataNumber(args.intent.metadata, "takeProfit")

    if (stopLoss === undefined && takeProfit === undefined) {
        return undefined
    }

    const childIds = args.identity
        ? {
            takeProfit: createChildExecutionIdentity(args.identity, "take_profit").providerClientOrderId,
            stopLoss: createChildExecutionIdentity(args.identity, "stop_loss").providerClientOrderId,
        }
        : undefined

    return [
        {
            attachAlgoClOrdId: stopLoss !== undefined && takeProfit === undefined
                ? childIds?.stopLoss
                : takeProfit !== undefined && stopLoss === undefined
                    ? childIds?.takeProfit
                    : childIds?.takeProfit,
            slTriggerPx: stopLoss !== undefined
                ? formatNumber(await args.normalizePrice(stopLoss))
                : undefined,
            slOrdPx: stopLoss !== undefined ? "-1" : undefined,
            tpTriggerPx: takeProfit !== undefined
                ? formatNumber(await args.normalizePrice(takeProfit))
                : undefined,
            tpOrdPx: takeProfit !== undefined ? "-1" : undefined,
        },
    ]
}

export async function cancelOKXProtectionOrders(args: {
    client: OKXClient
    instId: string
    side?: Position["side"]
    resolvePositionPosSide: (side: Position["side"]) => OKXApiPosSide
}): Promise<void> {
    const algoOrders = await args.client.getAlgoOrdersPending("SWAP", args.instId)
    const relevantOrders = args.side
        ? algoOrders.filter((order) =>
            matchesOKXPositionProtection(order, args.side!, args.resolvePositionPosSide)
        )
        : algoOrders

    if (relevantOrders.length === 0) {
        return
    }

    await args.client.cancelAlgoOrders(
        relevantOrders.map((order) => ({
            algoId: order.algoId,
            instId: order.instId,
        }))
    )
}

export async function updateOKXProtectionOrders(args: {
    client: OKXClient
    instrument: string
    stopLoss?: number
    takeProfit?: number
    marginMode: OKXMarginMode
    getPositions: () => Promise<Position[]>
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    baseQuantityToContracts: (rules: OKXInstrumentRules, quantity: number) => number
    normalizePrice: (price: number) => Promise<number>
    resolvePositionPosSide: (side: Position["side"]) => OKXApiPosSide
    identity: ExecutionIdentityContext
}): Promise<{ cancelledOrderIds: string[]; createdOrderIds: string[] }> {
    const positions = await args.getPositions()
    const position = positions.find((entry) => entry.instrument === args.instrument)

    if (!position) {
        throw createExecutionError("pre_validation", `No open OKX swap position found for ${args.instrument}`, {
            code: "POSITION_NOT_FOUND",
            retryable: false,
            details: {
                instrument: args.instrument,
            },
        })
    }

    const existingOrders = await args.client.getAlgoOrdersPending("SWAP", args.instrument)
    const relevantOrders = existingOrders.filter((order) =>
        matchesOKXPositionProtection(order, position.side, args.resolvePositionPosSide)
    )
    const cancelledOrderIds = await cancelRelevantProtectionOrders(
        args.client,
        args.instrument,
        relevantOrders
    )
    const createdOrderIds = await createRequestedProtectionOrders(args, position)

    if (createdOrderIds.length > 0) {
        await assertProtectionOrdersPending(args.client, args.instrument, createdOrderIds)
    }

    return {
        cancelledOrderIds,
        createdOrderIds,
    }
}

async function cancelRelevantProtectionOrders(
    client: OKXClient,
    instId: string,
    relevantOrders: OKXAlgoOrder[]
): Promise<string[]> {
    if (relevantOrders.length === 0) {
        return []
    }

    const acks = await client.cancelAlgoOrders(
        relevantOrders.map((order) => ({
            algoId: order.algoId,
            instId: order.instId,
        }))
    )

    return acks.map((ack) => toCompositeOrderId("algo", instId, ack.algoId))
}

async function createRequestedProtectionOrders(
    args: Parameters<typeof updateOKXProtectionOrders>[0],
    position: Position
): Promise<string[]> {
    const closeSide = position.side === "long" ? "sell" : "buy"
    const posSide = args.resolvePositionPosSide(position.side)
    const rules = await args.getInstrumentRules(args.instrument)
    const contracts = args.baseQuantityToContracts(rules, position.quantity)
    const size = formatContracts(contracts)
    const request = await buildProtectionAlgoOrderRequest({
        args,
        closeSide,
        posSide,
        size,
    })

    if (!request) {
        return []
    }

    const ack = await args.client.placeAlgoOrder(request)
    return [toCompositeOrderId("algo", args.instrument, ack.algoId)]
}

async function buildProtectionAlgoOrderRequest(config: {
    args: Parameters<typeof updateOKXProtectionOrders>[0]
    closeSide: "buy" | "sell"
    posSide: OKXApiPosSide
    size: string
}): Promise<OKXPlaceAlgoOrderParams | undefined> {
    const args = config.args
    const clientOrderId = resolveStandaloneProtectionClientOrderId(
        args.identity,
        args.stopLoss,
        args.takeProfit
    )
    const base = {
        instId: args.instrument,
        tdMode: args.marginMode,
        side: config.closeSide,
        posSide: config.posSide,
        sz: config.size,
        algoClOrdId: clientOrderId,
    }

    if (args.stopLoss !== undefined && args.takeProfit !== undefined) {
        return {
            ...base,
            ordType: "oco",
            slTriggerPx: formatNumber(await args.normalizePrice(args.stopLoss)),
            slOrdPx: "-1",
            tpTriggerPx: formatNumber(await args.normalizePrice(args.takeProfit)),
            tpOrdPx: "-1",
        }
    }

    if (args.stopLoss !== undefined) {
        return {
            ...base,
            ordType: "conditional",
            slTriggerPx: formatNumber(await args.normalizePrice(args.stopLoss)),
            slOrdPx: "-1",
        }
    }

    if (args.takeProfit !== undefined) {
        return {
            ...base,
            ordType: "conditional",
            tpTriggerPx: formatNumber(await args.normalizePrice(args.takeProfit)),
            tpOrdPx: "-1",
        }
    }

    return undefined
}

function resolveStandaloneProtectionClientOrderId(
    identity: ExecutionIdentityContext,
    stopLoss: number | undefined,
    takeProfit: number | undefined
): string {
    if (stopLoss !== undefined && takeProfit === undefined) {
        return createChildExecutionIdentity(identity, "stop_loss").providerClientOrderId
    }

    return createChildExecutionIdentity(identity, "take_profit").providerClientOrderId
}

async function assertProtectionOrdersPending(
    client: OKXClient,
    instId: string,
    createdOrderIds: string[]
): Promise<void> {
    const pending = await client.getAlgoOrdersPending("SWAP", instId)
    const pendingIds = new Set(
        pending.map((order) => toCompositeOrderId("algo", instId, order.algoId))
    )
    const missing = createdOrderIds.filter((orderId) => !pendingIds.has(orderId))

    if (missing.length === 0) {
        return
    }

    throw createExecutionError("venue", `OKX protection order placement did not appear in pending algo orders for ${instId}`, {
        code: "PROTECTION_NOT_PENDING",
        retryable: false,
        details: {
            instId,
            createdOrderIds,
            pendingOrderIds: Array.from(pendingIds),
            missing,
        },
    })
}
