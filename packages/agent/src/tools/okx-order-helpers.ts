import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getRiskBudgetBase,
    type ExecutionErrorDetail,
    type ExecutionPipeline,
    type OKXPolicy,
    type OrderIntent,
    type PriceVerification,
} from "@valiq-trading/core"
import { computeImpliedRR, computeTakeProfitFromRR } from "@valiq-trading/mt5"

export const okxOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    leverage: z.number().int().positive().max(5).optional(),
    orderType: z.enum(["market", "limit"]).default("market"),
    limitPrice: z.number().optional(),
    stopLoss: z.number(),
    takeProfit: z.number().optional(),
    riskRewardRatio: z.number().positive().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("gtc"),
    reason: z.string(),
})

export type OKXOrderParams = z.infer<typeof okxOrderParamsSchema>

export const okxOrderJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "OKX swap instrument, e.g. BTC-USDT-SWAP or ETH-USDT-SWAP" },
        side: { type: "string", enum: ["buy", "sell"] },
        leverage: { type: "number", description: "Leverage to apply for this trade. Must be <= policy maxLeverage." },
        orderType: { type: "string", enum: ["market", "limit"], default: "market" },
        limitPrice: { type: "number", description: "Required for limit entries" },
        stopLoss: { type: "number", description: "Absolute stop-loss price. Always required." },
        takeProfit: { type: "number", description: "Absolute take-profit price. Provide this OR riskRewardRatio." },
        riskRewardRatio: { type: "number", description: "Risk-reward ratio used to derive takeProfit. Provide this OR takeProfit." },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "gtc" },
        reason: { type: "string", description: "Trade rationale" },
    },
    required: ["instrument", "side", "stopLoss", "reason"],
} as const

export interface OKXOrderResult {
    orderId: string
    status: string
    filledQuantity: number
    fillPrice?: number
    error?: string
    errorDetail?: ExecutionErrorDetail
    priceVerification?: PriceVerification
    protectionOrders?: {
        cancelledOrderIds: string[]
        createdOrderIds: string[]
        error?: string
    }
    computed?: {
        entryPrice: number
        stopLoss: number
        takeProfit: number
        quantity: number
        leverage: number
        riskAmount: number
        riskPercent: number
        impliedRR: number
        fundingRate?: number
    }
    riskValidation: {
        allowed: boolean
        reason?: string
    }
}

export async function prepareOKXOrder(
    params: OKXOrderParams,
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter,
    policy: OKXPolicy,
    action: "entry" | "adjustment"
): Promise<OKXOrderResult> {
    const hasTp = params.takeProfit !== undefined
    const hasRr = params.riskRewardRatio !== undefined

    if (!hasTp && !hasRr) {
        return rejected("Provide either takeProfit or riskRewardRatio")
    }

    if (hasTp && hasRr) {
        return rejected("Provide takeProfit OR riskRewardRatio, not both")
    }

    if (params.orderType === "limit" && params.limitPrice === undefined) {
        return rejected("Provide limitPrice for OKX limit orders")
    }

    const leverage = params.leverage ?? policy.maxLeverage
    if (leverage > policy.maxLeverage) {
        return rejected(`Leverage ${leverage}x exceeds policy maxLeverage ${policy.maxLeverage}x`)
    }

    const instrument = params.instrument.toUpperCase()
    const markPrice = await venue.getCurrentMarkPrice(instrument)
    const entryPrice = params.orderType === "limit"
        ? params.limitPrice ?? 0
        : markPrice

    if (entryPrice <= 0) {
        return rejected("Could not resolve entry price. Provide limitPrice for limit orders.")
    }

    if (params.side === "buy" && params.stopLoss >= entryPrice) {
        return rejected(`stopLoss ${params.stopLoss} must be below entry ${entryPrice} for buy orders`)
    }

    if (params.side === "sell" && params.stopLoss <= entryPrice) {
        return rejected(`stopLoss ${params.stopLoss} must be above entry ${entryPrice} for sell orders`)
    }

    let takeProfit: number
    let impliedRR: number

    if (hasRr) {
        takeProfit = computeTakeProfitFromRR(entryPrice, params.stopLoss, params.riskRewardRatio!, params.side)
        impliedRR = params.riskRewardRatio!
    } else {
        const rrResult = computeImpliedRR(entryPrice, params.stopLoss, params.takeProfit!, params.side)
        if (typeof rrResult === "object" && "error" in rrResult) {
            return rejected(rrResult.error)
        }
        takeProfit = params.takeProfit!
        impliedRR = rrResult
    }

    const [account, positions, fundingRate] = await Promise.all([
        pipeline.getAccountState(),
        pipeline.getPositions(),
        venue.getCurrentFundingRate(instrument).catch(() => undefined),
    ])

    const riskBudgetBase = getRiskBudgetBase(account)
    if (riskBudgetBase <= 0) {
        return rejected("Account balance is zero or negative")
    }

    const stopDistance = Math.abs(entryPrice - params.stopLoss)
    if (stopDistance <= 0) {
        return rejected("stopLoss distance must be greater than zero")
    }

    const riskBudget = riskBudgetBase * (policy.maxRiskPercent / 100)
    let rawQuantity = riskBudget / stopDistance

    if (entryPrice > 0 && account.marginAvailable > 0) {
        const maxNotional = account.marginAvailable * leverage
        rawQuantity = Math.min(rawQuantity, maxNotional / entryPrice)
    }

    const sizing = await venue.normalizeQuantity(instrument, rawQuantity)
    if (sizing.baseQuantity <= 0) {
        return rejected(`Computed quantity ${rawQuantity} falls below minimum contract size for ${instrument}`)
    }

    const normalizedStopLoss = await venue.normalizePrice(instrument, params.stopLoss)
    const normalizedTakeProfit = await venue.normalizePrice(instrument, takeProfit)
    const normalizedLimitPrice = params.limitPrice !== undefined
        ? await venue.normalizePrice(instrument, params.limitPrice)
        : undefined

    const actualRiskAmount = sizing.baseQuantity * Math.abs(entryPrice - normalizedStopLoss)
    const actualRiskPercent = (actualRiskAmount / riskBudgetBase) * 100

    const intent: OrderIntent = {
        instrument,
        side: params.side,
        quantity: sizing.baseQuantity,
        orderType: params.orderType,
        limitPrice: normalizedLimitPrice,
        timeInForce: params.timeInForce,
        metadata: {
            action,
            leverage,
            stopLoss: normalizedStopLoss,
            takeProfit: normalizedTakeProfit,
            riskAmount: actualRiskAmount,
            riskPercent: actualRiskPercent,
            impliedRR,
            reason: params.reason,
            estimatedPrice: entryPrice,
            fundingRate,
        },
    }

    const { result, validation } = await pipeline.executeIntent(
        intent,
        account,
        positions,
        { action }
    )

    const protectionOrders = action === "entry" && validation.allowed
        ? await ensureProtectionOrders({
            venue,
            instrument,
            stopLoss: normalizedStopLoss,
            takeProfit: normalizedTakeProfit,
            dryRun: policy.dryRun,
            status: result.status,
        })
        : undefined

    return {
        orderId: result.orderId,
        status: result.status,
        filledQuantity: result.filledQuantity,
        fillPrice: result.fillPrice,
        error: result.error,
        errorDetail: result.errorDetail,
        priceVerification: result.priceVerification,
        protectionOrders,
        computed: {
            entryPrice,
            stopLoss: normalizedStopLoss,
            takeProfit: normalizedTakeProfit,
            quantity: sizing.baseQuantity,
            leverage,
            riskAmount: actualRiskAmount,
            riskPercent: actualRiskPercent,
            impliedRR,
            fundingRate,
        },
        riskValidation: {
            allowed: validation.allowed,
            reason: validation.reason,
        },
    }
}

function rejected(error: string): OKXOrderResult {
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

async function ensureProtectionOrders(config: {
    venue: OKXVenueAdapter
    instrument: string
    stopLoss: number
    takeProfit: number
    dryRun?: boolean
    status: string
}): Promise<{
    cancelledOrderIds: string[]
    createdOrderIds: string[]
    error?: string
}> {
    if (config.dryRun) {
        return {
            cancelledOrderIds: [],
            createdOrderIds: [],
            error: "Dry run mode: protection orders not sent to OKX",
        }
    }

    if (config.status === "pending") {
        return {
            cancelledOrderIds: [],
            createdOrderIds: [],
            error: "Entry order is pending. Re-run propose_adjustment after fill to attach or refresh SL/TP.",
        }
    }

    if (config.status !== "filled" && config.status !== "partially_filled") {
        return {
            cancelledOrderIds: [],
            createdOrderIds: [],
            error: `Entry order status is ${config.status}. Protection orders were not updated.`,
        }
    }

    let lastError: string | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const updated = await config.venue.updateProtectionOrders({
                instrument: config.instrument,
                stopLoss: config.stopLoss,
                takeProfit: config.takeProfit,
            })

            return {
                cancelledOrderIds: updated.cancelledOrderIds,
                createdOrderIds: updated.createdOrderIds,
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            const shouldRetry = lastError.includes("POSITION_NOT_FOUND") || lastError.includes("No open OKX swap position found")

            if (!shouldRetry || attempt === 2) {
                break
            }

            await delay((attempt + 1) * 500)
        }
    }

    return {
        cancelledOrderIds: [],
        createdOrderIds: [],
        error: lastError ?? "Failed to update protection orders",
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
