import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    type BinancePolicy,
    type ExecutionErrorDetail,
    type ExecutionPipeline,
    type OrderIntent,
} from "@valiq-trading/core"
import { computeImpliedRR, computeTakeProfitFromRR } from "@valiq-trading/mt5"

export const binanceOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    leverage: z.number().int().positive().max(5).optional(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]).default("market"),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    stopLoss: z.number(),
    takeProfit: z.number().optional(),
    riskRewardRatio: z.number().positive().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("gtc"),
    reason: z.string(),
})

export type BinanceOrderParams = z.infer<typeof binanceOrderParamsSchema>

export const binanceOrderJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "Perpetual symbol, e.g. BTCUSDT or ETHUSDT" },
        side: { type: "string", enum: ["buy", "sell"] },
        leverage: { type: "number", description: "Leverage to apply for this trade. Must be <= policy maxLeverage." },
        orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"], default: "market" },
        limitPrice: { type: "number", description: "Required for limit/stop_limit entries" },
        stopPrice: { type: "number", description: "Required for stop/stop_limit entries" },
        stopLoss: { type: "number", description: "Absolute stop-loss price. Always required." },
        takeProfit: { type: "number", description: "Absolute take-profit price. Provide this OR riskRewardRatio." },
        riskRewardRatio: { type: "number", description: "Risk-reward ratio used to derive takeProfit. Provide this OR takeProfit." },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "gtc" },
        reason: { type: "string", description: "Trade rationale" },
    },
    required: ["instrument", "side", "stopLoss", "reason"],
} as const

export interface BinanceOrderResult {
    orderId: string
    status: string
    filledQuantity: number
    fillPrice?: number
    error?: string
    errorDetail?: ExecutionErrorDetail
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

export async function prepareBinanceOrder(
    params: BinanceOrderParams,
    pipeline: ExecutionPipeline,
    venue: BinanceVenueAdapter,
    policy: BinancePolicy,
    action: "entry" | "adjustment"
): Promise<BinanceOrderResult> {
    const hasTp = params.takeProfit !== undefined
    const hasRr = params.riskRewardRatio !== undefined

    if (!hasTp && !hasRr) {
        return rejected("Provide either takeProfit or riskRewardRatio")
    }

    if (hasTp && hasRr) {
        return rejected("Provide takeProfit OR riskRewardRatio, not both")
    }

    const leverage = params.leverage ?? policy.maxLeverage
    if (leverage > policy.maxLeverage) {
        return rejected(`Leverage ${leverage}x exceeds policy maxLeverage ${policy.maxLeverage}x`)
    }

    const symbol = params.instrument.toUpperCase()
    const markPrice = await venue.getCurrentMarkPrice(symbol)
    const entryPrice = resolveEntryPrice(params, markPrice)

    if (entryPrice <= 0) {
        return rejected("Could not resolve entry price. Provide limitPrice for limit/stop_limit or stopPrice for stop.")
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
        venue.getCurrentFundingRate(symbol).catch(() => undefined),
    ])

    if (account.balance <= 0) {
        return rejected("Account balance is zero or negative")
    }

    const stopDistance = Math.abs(entryPrice - params.stopLoss)
    if (stopDistance <= 0) {
        return rejected("stopLoss distance must be greater than zero")
    }

    const riskBudget = account.balance * (policy.maxRiskPercent / 100)
    let rawQuantity = riskBudget / stopDistance

    if (entryPrice > 0 && account.marginAvailable > 0) {
        const maxNotional = account.marginAvailable * leverage
        rawQuantity = Math.min(rawQuantity, maxNotional / entryPrice)
    }

    const quantity = await venue.normalizeQuantity(symbol, rawQuantity)
    if (quantity <= 0) {
        return rejected(`Computed quantity ${rawQuantity} falls below minimum lot size for ${symbol}`)
    }

    const normalizedStopLoss = await venue.normalizePrice(symbol, params.stopLoss)
    const normalizedTakeProfit = await venue.normalizePrice(symbol, takeProfit)
    const normalizedLimitPrice = params.limitPrice !== undefined
        ? await venue.normalizePrice(symbol, params.limitPrice)
        : undefined
    const normalizedStopPrice = params.stopPrice !== undefined
        ? await venue.normalizePrice(symbol, params.stopPrice)
        : undefined

    const actualRiskAmount = quantity * Math.abs(entryPrice - normalizedStopLoss)
    const actualRiskPercent = (actualRiskAmount / account.balance) * 100

    const intent: OrderIntent = {
        instrument: symbol,
        side: params.side,
        quantity,
        orderType: params.orderType,
        limitPrice: normalizedLimitPrice,
        stopPrice: normalizedStopPrice,
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
            symbol,
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
        protectionOrders,
        computed: {
            entryPrice,
            stopLoss: normalizedStopLoss,
            takeProfit: normalizedTakeProfit,
            quantity,
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

function resolveEntryPrice(
    params: BinanceOrderParams,
    markPrice: number
): number {
    if (params.orderType === "market") {
        return markPrice
    }

    if (params.orderType === "limit" || params.orderType === "stop_limit") {
        return params.limitPrice ?? 0
    }

    if (params.orderType === "stop") {
        return params.stopPrice ?? 0
    }

    return 0
}

function rejected(error: string): BinanceOrderResult {
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
    venue: BinanceVenueAdapter
    symbol: string
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
            error: "Dry run mode: protection orders not sent to Binance",
        }
    }

    if (config.status === "pending") {
        return {
            cancelledOrderIds: [],
            createdOrderIds: [],
            error: "Entry order is pending. Re-run propose_adjustment after fill to attach SL/TP.",
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
                instrument: config.symbol,
                stopLoss: config.stopLoss,
                takeProfit: config.takeProfit,
            })

            return {
                cancelledOrderIds: updated.cancelledOrderIds,
                createdOrderIds: updated.createdOrderIds,
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            const shouldRetry = lastError.includes("No open position found")

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
