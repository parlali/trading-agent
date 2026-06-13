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
    const timestamp = parseUnixMs(args.order.uTime) ?? parseUnixMs(args.order.cTime) ?? Date.now()
    const accountingMetadata = buildOKXOrderAccountingMetadata(args.order, status, timestamp)
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
        providerOrderId: toCompositeOrderId("order", args.instId, args.order.ordId),
        providerClientOrderId: args.order.clOrdId,
        providerOrderAliases: [args.order.ordId, args.order.clOrdId].filter((value): value is string => Boolean(value)),
        status,
        filledQuantity,
        fillPrice,
        timestamp,
        error: errorDetail ? formatExecutionError(errorDetail) : undefined,
        errorDetail,
        intentUpdates: accountingMetadata
            ? { metadata: accountingMetadata }
            : undefined,
    }
}

export function buildOKXOrderAccountingMetadata(
    order: OKXOrder,
    status: ExecutionResult["status"],
    accountingOccurredAt?: number
): Record<string, unknown> | undefined {
    if (status !== "filled" && status !== "partially_filled") {
        return undefined
    }

    if (order.reduceOnly === "true") {
        return undefined
    }

    const fee = isFiniteNumberString(order.fee) ? Number(order.fee) : undefined
    const fillPnl = isFiniteNumberString(order.pnl) ? Number(order.pnl) : undefined
    const metadata: Record<string, unknown> = {
        providerAccountingSource: "okx_order",
        providerOrderId: order.ordId,
        providerClientOrderId: order.clOrdId,
        tradeId: order.tradeId,
    }

    if (accountingOccurredAt !== undefined) {
        metadata.providerAccountingOccurredAt = accountingOccurredAt
    }

    if (fee !== undefined) {
        metadata.fee = fee
    }

    if (order.feeCcy) {
        metadata.feeCcy = order.feeCcy
    }

    if (fillPnl !== undefined) {
        metadata.fillPnl = fillPnl
    }

    if (fee === undefined && fillPnl === undefined) {
        metadata.providerAccountingMissing = true
        metadata.providerAccountingMissingReason = "okx_order_fee_and_pnl_unparseable"
    }

    return metadata
}
