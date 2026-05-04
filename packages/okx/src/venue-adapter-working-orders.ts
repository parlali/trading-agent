import type {
    Position,
    WorkingOrder,
} from "@valiq-trading/core"
import type {
    OKXAlgoOrder,
    OKXApiPosSide,
    OKXOrder,
} from "./okx-client"
import {
    isFiniteNumberString,
    mapOKXAlgoOrderStatus,
    mapOKXOrderStatus,
    parseUnixMs,
    toCompositeOrderId,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

export async function mapOKXWorkingOrders(args: {
    orders: OKXOrder[]
    algoOrders: OKXAlgoOrder[]
    positions: Position[]
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
    resolvePositionPosSide: (side: Position["side"]) => OKXApiPosSide
    getProtectionKey: (instId: string, posSide: string | undefined) => string
}): Promise<WorkingOrder[]> {
    const quantityByInstrument = new Map(
        args.positions.map((position) => [
            args.getProtectionKey(position.instrument, args.resolvePositionPosSide(position.side)),
            position.quantity,
        ])
    )

    const standardOrders = await Promise.all(
        args.orders.map(async (order) => {
            const rules = await args.getInstrumentRules(order.instId)
            const quantity = args.contractsToBaseQuantity(rules, Number(order.sz))
            const filledQuantity = args.contractsToBaseQuantity(rules, Number(order.accFillSz))
            const submittedAt = parseUnixMs(order.cTime)
            const updatedAt = parseUnixMs(order.uTime) ?? submittedAt ?? Date.now()

            return {
                orderId: toCompositeOrderId("order", order.instId, order.ordId),
                instrument: order.instId,
                status: mapOKXOrderStatus(order.state),
                quantity,
                filledQuantity,
                remainingQuantity: Math.max(quantity - filledQuantity, 0),
                submittedAt: submittedAt ?? updatedAt,
                updatedAt,
                side: order.side,
                limitPrice: isFiniteNumberString(order.px) && Number(order.px) > 0 ? Number(order.px) : undefined,
                avgFillPrice: isFiniteNumberString(order.avgPx) && Number(order.avgPx) > 0 ? Number(order.avgPx) : undefined,
                metadata: {
                    orderType: order.ordType,
                    reduceOnly: order.reduceOnly === "true",
                    tdMode: order.tdMode,
                    posSide: order.posSide,
                },
            } satisfies WorkingOrder
        })
    )

    const protectionOrders = args.algoOrders.map((order) => {
        const quantity = quantityByInstrument.get(
            args.getProtectionKey(order.instId, order.posSide)
        ) ?? 0
        const submittedAt = parseUnixMs(order.cTime) ?? Date.now()
        const updatedAt = parseUnixMs(order.uTime) ?? submittedAt

        return {
            orderId: toCompositeOrderId("algo", order.instId, order.algoId),
            instrument: order.instId,
            status: mapOKXAlgoOrderStatus(order.state),
            quantity,
            filledQuantity: 0,
            remainingQuantity: quantity,
            submittedAt,
            updatedAt,
            side: order.side,
            stopPrice: isFiniteNumberString(order.slTriggerPx) ? Number(order.slTriggerPx) : undefined,
            limitPrice: isFiniteNumberString(order.tpTriggerPx) ? Number(order.tpTriggerPx) : undefined,
            metadata: {
                orderType: order.ordType,
                kind: "protection",
                posSide: order.posSide,
                tpTriggerPx: order.tpTriggerPx,
                slTriggerPx: order.slTriggerPx,
            },
        } satisfies WorkingOrder
    })

    return [...standardOrders, ...protectionOrders]
}
