import {
    createExecutionErrorDetail,
    formatExecutionError,
    type ExecutionResult,
} from "@valiq-trading/core"
import type { OKXOrder } from "./okx-client"
import {
    isFiniteNumberString,
    mapOKXOrderStatus,
    parseUnixMs,
    toCompositeOrderId,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

export async function mapOKXExecutionResult(args: {
    instId: string
    order: OKXOrder
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
}): Promise<ExecutionResult> {
    const rules = await args.getInstrumentRules(args.instId)
    const filledQuantity = args.contractsToBaseQuantity(rules, Number(args.order.accFillSz))
    const fillPrice = isFiniteNumberString(args.order.avgPx) && Number(args.order.avgPx) > 0
        ? Number(args.order.avgPx)
        : isFiniteNumberString(args.order.px) && Number(args.order.px) > 0
            ? Number(args.order.px)
            : undefined
    const status = mapOKXOrderStatus(args.order.state)
    const accountingMetadata = buildOKXOrderAccountingMetadata(args.order, status)
    const errorDetail = status === "rejected"
        ? createExecutionErrorDetail("venue", args.order.state, {
            code: args.order.state,
            retryable: false,
            details: {
                instId: args.instId,
                ordId: args.order.ordId,
            },
        })
        : undefined

    return {
        orderId: toCompositeOrderId("order", args.instId, args.order.ordId),
        status,
        filledQuantity,
        fillPrice,
        timestamp: parseUnixMs(args.order.uTime) ?? parseUnixMs(args.order.cTime) ?? Date.now(),
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
        intentUpdates: accountingMetadata
            ? { metadata: accountingMetadata }
            : undefined,
    }
}

function buildOKXOrderAccountingMetadata(
    order: OKXOrder,
    status: ExecutionResult["status"]
): Record<string, unknown> | undefined {
    if (status !== "filled" && status !== "partially_filled") {
        return undefined
    }

    if (order.reduceOnly === "true") {
        return undefined
    }

    const fee = isFiniteNumberString(order.fee) ? Number(order.fee) : undefined
    const fillPnl = isFiniteNumberString(order.pnl) ? Number(order.pnl) : undefined
    if (fee === undefined && fillPnl === undefined) {
        return undefined
    }

    return {
        fee,
        feeCcy: order.feeCcy,
        fillPnl,
        providerAccountingSource: "okx_order",
        providerOrderId: order.ordId,
        tradeId: order.tradeId,
    }
}
