import { z } from "zod"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    type ExecutionErrorDetail,
    type ExecutionPipeline,
    type MT5Policy,
    type OrderIntent,
} from "@valiq-trading/core"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import {
    calculateLotSize,
    computeTakeProfitFromRR,
    computeImpliedRR,
} from "@valiq-trading/mt5"

export const mt5OrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    stopLoss: z.number(),
    takeProfit: z.number().optional(),
    riskRewardRatio: z.number().positive().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("gtc"),
    reason: z.string(),
})

export type MT5OrderParams = z.infer<typeof mt5OrderParamsSchema>

export const mt5OrderJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument/ticker symbol (e.g. EURUSD, XAUUSD)" },
        side: { type: "string", enum: ["buy", "sell"] },
        orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
        limitPrice: { type: "number", description: "Entry price for limit/stop_limit orders" },
        stopPrice: { type: "number", description: "Trigger price for stop/stop_limit orders" },
        stopLoss: { type: "number", description: "Absolute price level for stop-loss. Always required." },
        takeProfit: { type: "number", description: "Absolute price level for take-profit. Provide this OR riskRewardRatio, not both." },
        riskRewardRatio: { type: "number", description: "Risk-reward ratio (e.g. 2.0 means TP distance is 2x SL distance). Provide this OR takeProfit, not both." },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "gtc" },
        reason: { type: "string", description: "Why this trade is being taken" },
    },
    required: ["instrument", "side", "orderType", "stopLoss", "reason"],
} as const

export interface MT5OrderResult {
    orderId: string
    status: string
    filledQuantity: number
    fillPrice?: number
    error?: string
    errorDetail?: ExecutionErrorDetail
    computed?: {
        entryPrice: number
        stopLoss: number
        takeProfit: number
        volume: number
        riskAmount: number
        riskPercent: number
        impliedRR: number
    }
    riskValidation: {
        allowed: boolean
        reason?: string
    }
}

export async function prepareMT5Order(
    params: MT5OrderParams,
    pipeline: ExecutionPipeline,
    venue: MT5VenueAdapter,
    policy: MT5Policy,
    action: "entry" | "adjustment"
): Promise<MT5OrderResult> {
    const hasTP = params.takeProfit !== undefined
    const hasRR = params.riskRewardRatio !== undefined

    if (!hasTP && !hasRR) {
        return rejected("Provide either takeProfit or riskRewardRatio with your order")
    }

    if (hasTP && hasRR) {
        return rejected("Provide takeProfit OR riskRewardRatio, not both")
    }

    const symbolInfo = await venue.getSymbolInfo(params.instrument)
    if (!symbolInfo) {
        return rejected(`Symbol ${params.instrument} not found or unavailable`)
    }

    const entryPrice = resolveEntryPrice(params, symbolInfo.bid, symbolInfo.ask)
    if (entryPrice <= 0) {
        return rejected("Could not determine entry price. For limit/stop orders, provide limitPrice or stopPrice.")
    }

    if (params.side === "buy" && params.stopLoss >= entryPrice) {
        return rejected(`Stop-loss ${params.stopLoss} must be below entry ${entryPrice} for buy orders`)
    }

    if (params.side === "sell" && params.stopLoss <= entryPrice) {
        return rejected(`Stop-loss ${params.stopLoss} must be above entry ${entryPrice} for sell orders`)
    }

    let takeProfit: number
    let impliedRR: number

    if (hasRR) {
        takeProfit = computeTakeProfitFromRR(
            entryPrice,
            params.stopLoss,
            params.riskRewardRatio!,
            params.side
        )
        impliedRR = params.riskRewardRatio!
    } else {
        const rrResult = computeImpliedRR(
            entryPrice,
            params.stopLoss,
            params.takeProfit!,
            params.side
        )

        if (typeof rrResult === "object" && "error" in rrResult) {
            return rejected(rrResult.error)
        }

        takeProfit = params.takeProfit!
        impliedRR = rrResult
    }

    if (impliedRR < policy.minRiskReward) {
        return rejected(
            `Risk-reward ratio ${impliedRR.toFixed(2)} is below minimum ${policy.minRiskReward}. Widen your TP or tighten your SL.`
        )
    }

    const [account, positions] = await Promise.all([
        pipeline.getAccountState(),
        pipeline.getPositions(),
    ])

    const lotResult = calculateLotSize({
        accountBalance: account.balance,
        maxRiskPercent: policy.maxRiskPercent,
        entryPrice,
        stopLossPrice: params.stopLoss,
        side: params.side,
        symbolInfo,
    })

    if ("error" in lotResult) {
        return rejected(lotResult.error)
    }

    const intent: OrderIntent = {
        instrument: params.instrument,
        side: params.side,
        quantity: lotResult.volume,
        orderType: params.orderType,
        limitPrice: params.limitPrice,
        stopPrice: params.stopPrice,
        timeInForce: params.timeInForce,
        metadata: {
            action,
            stopLoss: params.stopLoss,
            takeProfit,
            riskAmount: lotResult.riskAmount,
            riskPercent: lotResult.riskPercent,
            impliedRR: impliedRR,
            reason: params.reason,
            estimatedPrice: entryPrice,
        },
    }

    const { result, validation } = await pipeline.executeIntent(
        intent,
        account,
        positions,
        { action }
    )

    return {
        orderId: result.orderId,
        status: result.status,
        filledQuantity: result.filledQuantity,
        fillPrice: result.fillPrice,
        error: result.error,
        errorDetail: result.errorDetail,
        computed: {
            entryPrice,
            stopLoss: params.stopLoss,
            takeProfit,
            volume: lotResult.volume,
            riskAmount: lotResult.riskAmount,
            riskPercent: lotResult.riskPercent,
            impliedRR,
        },
        riskValidation: {
            allowed: validation.allowed,
            reason: validation.reason,
        },
    }
}

function resolveEntryPrice(
    params: MT5OrderParams,
    bid: number,
    ask: number
): number {
    if (params.orderType === "market") {
        return params.side === "buy" ? ask : bid
    }

    if (params.orderType === "limit" || params.orderType === "stop_limit") {
        return params.limitPrice ?? 0
    }

    if (params.orderType === "stop") {
        return params.stopPrice ?? 0
    }

    return 0
}

function rejected(error: string): MT5OrderResult {
    const errorDetail = createExecutionErrorDetail("pre_validation", error, {
        retryable: false,
    })

    return {
        orderId: "",
        status: "rejected",
        filledQuantity: 0,
        error: formatExecutionError(errorDetail),
        errorDetail,
        riskValidation: {
            allowed: false,
            reason: errorDetail.message,
        },
    }
}
