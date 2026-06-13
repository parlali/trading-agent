import { z } from "zod"
import { OKX_ESTIMATED_ONE_WAY_FEE_RATE, type OKXVenueAdapter } from "@valiq-trading/okx"
import {
    getRiskBudgetBase,
    type ExecutionSafetyFaultCategory,
    type ExecutionErrorDetail,
    type ExecutionPipeline,
    type OKXPolicy,
    type OrderIntent,
    type Position,
    type PriceVerification,
    type SubmitOrderContext,
    type WorkingOrder,
} from "@valiq-trading/core"
import { computeImpliedRR, computeTakeProfitFromRR } from "@valiq-trading/mt5"
import { createRejectedExecutionToolResult } from "./execution-response"
import { assertToolNotAborted, createToolAbortError } from "../tool-registry"

export const okxOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    leverage: z.number().int().positive().max(5).optional(),
    orderType: z.enum(["market", "limit"]).default("market"),
    limitPrice: z.number().optional(),
    stopLoss: z.number(),
    takeProfit: z.number().optional(),
    riskRewardRatio: z.number().positive().optional(),
    timeInForce: z.enum(["gtc", "ioc", "fok"]).default("gtc"),
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
        timeInForce: { type: "string", enum: ["gtc", "ioc", "fok"], default: "gtc" },
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
        category?: OKXProtectionFailureCategory
        flattened?: boolean
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

export type OKXProtectionFailureCategory = Extract<
    ExecutionSafetyFaultCategory,
    "position_not_found_yet" | "provider_rejected" | "already_exists_conflict" | "invalid_params" | "unknown"
>

export interface OKXExecutionSafetyCallbacks {
    recordFault?: (args: {
        instrument: string
        category: OKXProtectionFailureCategory
        message: string
        providerPayload?: string
        canonicalOrderId?: string
        providerOrderId?: string
        providerClientOrderId?: string
        providerOrderAliases?: string[]
        submitAttemptId?: string
        submitAttemptSequence?: number
        venue?: string
        recoveryProbeEvidence?: Record<string, unknown>
    }) => Promise<void>
    resolveFaults?: (args: {
        instrument: string
        resolutionNote: string
    }) => Promise<void>
}

export async function prepareOKXOrder(
    params: OKXOrderParams,
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter,
    policy: OKXPolicy,
    action: "entry" | "adjustment",
    callbacks?: OKXExecutionSafetyCallbacks,
    signal?: AbortSignal
): Promise<OKXOrderResult> {
    assertToolNotAborted(signal)

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
    assertToolNotAborted(signal)
    const markPrice = await venue.getCurrentMarkPrice(instrument)
    assertToolNotAborted(signal)
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

    assertToolNotAborted(signal)
    const [account, positions, workingOrders, fundingRate] = await Promise.all([
        pipeline.getAccountState(),
        pipeline.getPositions(),
        venue.getWorkingOrders(),
        venue.getCurrentFundingRate(instrument).catch(() => undefined),
    ])
    assertToolNotAborted(signal)

    if (action === "entry") {
        const liveExposureBlock = resolveLiveEntryExposureBlock(instrument, positions, workingOrders)
        if (liveExposureBlock) {
            return rejected(liveExposureBlock)
        }
    }

    const riskBudgetBase = getRiskBudgetBase(account)
    if (riskBudgetBase <= 0) {
        return rejected("Account balance is zero or negative")
    }

    const stopDistance = Math.abs(entryPrice - params.stopLoss)
    if (stopDistance <= 0) {
        return rejected("stopLoss distance must be greater than zero")
    }

    const riskBudget = riskBudgetBase * (policy.maxRiskPercent / 100)
    const estimatedRoundTripFeePerUnit = entryPrice * OKX_ESTIMATED_ONE_WAY_FEE_RATE * 2
    let rawQuantity = riskBudget / (stopDistance + estimatedRoundTripFeePerUnit)

    if (entryPrice > 0 && account.marginAvailable > 0) {
        const maxNotional = account.marginAvailable * leverage
        rawQuantity = Math.min(rawQuantity, maxNotional / entryPrice)
    }

    const sizing = await venue.normalizeQuantity(instrument, rawQuantity)
    assertToolNotAborted(signal)
    if (sizing.baseQuantity <= 0) {
        return rejected(`Computed quantity ${rawQuantity} falls below minimum contract size for ${instrument}`)
    }

    const normalizedStopLoss = await venue.normalizePrice(instrument, params.stopLoss)
    assertToolNotAborted(signal)
    const normalizedTakeProfit = await venue.normalizePrice(instrument, takeProfit)
    assertToolNotAborted(signal)
    const normalizedLimitPrice = params.limitPrice !== undefined
        ? await venue.normalizePrice(instrument, params.limitPrice)
        : undefined
    assertToolNotAborted(signal)

    const estimatedRoundTripFees = sizing.baseQuantity * entryPrice * OKX_ESTIMATED_ONE_WAY_FEE_RATE * 2
    const actualRiskAmount = sizing.baseQuantity * Math.abs(entryPrice - normalizedStopLoss) + estimatedRoundTripFees
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
            estimatedRoundTripFees,
            impliedRR,
            reason: params.reason,
            estimatedPrice: entryPrice,
            fundingRate,
            cancelAt: resolveCancelAt(policy, action, params.orderType),
        },
    }

    const { result, validation } = await pipeline.executeIntent(
        intent,
        account,
        positions,
        { action }
    )
    assertToolNotAborted(signal)

    const protectionOrders = action === "entry" && validation.allowed
        ? await ensureProtectionOrders({
            pipeline,
            venue,
            instrument,
            stopLoss: normalizedStopLoss,
            takeProfit: normalizedTakeProfit,
            side: params.side,
            quantity: sizing.baseQuantity,
            dryRun: policy.dryRun,
            status: result.status,
            requireTakeProfit: policy.requireTakeProfit,
            callbacks,
            signal,
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
    return createRejectedExecutionToolResult(error)
}

function resolveLiveEntryExposureBlock(
    instrument: string,
    positions: readonly Position[],
    workingOrders: readonly WorkingOrder[]
): string | undefined {
    const livePosition = positions.find((position) =>
        position.instrument.toUpperCase() === instrument &&
        Math.abs(position.quantity) > 0
    )
    if (livePosition) {
        return `OKX entry blocked: ${instrument} already has a live ${livePosition.side} position. Use propose_adjustment or propose_close before adding exposure.`
    }

    const liveEntryOrders = workingOrders.filter((order) =>
        order.instrument.toUpperCase() === instrument &&
        !isOKXProtectionWorkingOrder(order)
    )
    if (liveEntryOrders.length === 0) {
        return undefined
    }

    const orderIds = liveEntryOrders.map((order) => order.orderId).join(", ")
    return `OKX entry blocked: ${instrument} already has live non-protection working order(s): ${orderIds}. Cancel or resolve them before adding exposure.`
}

function isOKXProtectionWorkingOrder(order: WorkingOrder): boolean {
    return order.metadata?.kind === "protection"
}

function resolveCancelAt(
    policy: OKXPolicy,
    action: "entry" | "adjustment",
    orderType: "market" | "limit"
): number | undefined {
    if (action !== "entry" || orderType !== "limit") {
        return undefined
    }

    const ttlMinutes = policy.safety.pendingEntryTtlMinutes
    if (ttlMinutes === undefined || ttlMinutes <= 0) {
        return undefined
    }

    return Date.now() + ttlMinutes * 60_000
}

export function classifyOKXProtectionFailure(
    errorMessage: string
): OKXProtectionFailureCategory {
    const normalized = errorMessage.toLowerCase()

    if (normalized.includes("position_not_found") || normalized.includes("no open okx swap position found")) {
        return "position_not_found_yet"
    }

    if (normalized.includes("already exists") || normalized.includes("conflict") || normalized.includes("duplicate")) {
        return "already_exists_conflict"
    }

    if (normalized.includes("invalid") || normalized.includes("parameter") || normalized.includes("price")) {
        return "invalid_params"
    }

    if (normalized.includes("rejected") || normalized.includes("scode") || normalized.includes("order_failed")) {
        return "provider_rejected"
    }

    return "unknown"
}

async function verifyProtectionFromProviderTruth(config: {
    venue: OKXVenueAdapter
    instrument: string
    requireTakeProfit: boolean
    signal?: AbortSignal
}): Promise<{ ok: boolean; reason?: string; protectionOrderIds: string[] }> {
    assertToolNotAborted(config.signal)
    const positions = await config.venue.getPositions()
    assertToolNotAborted(config.signal)
    const position = positions.find((entry) => entry.instrument === config.instrument)
    if (!position) {
        return {
            ok: false,
            reason: `position_not_found:${config.instrument}`,
            protectionOrderIds: [],
        }
    }

    const workingOrders = config.venue.getWorkingOrders
        ? await config.venue.getWorkingOrders()
        : []
    assertToolNotAborted(config.signal)
    const protectionOrderIds = workingOrders
        .filter((order) =>
            order.instrument === config.instrument &&
            order.metadata?.kind === "protection"
        )
        .map((order) => order.orderId)

    if (position.stopLoss === undefined) {
        return {
            ok: false,
            reason: `stop_loss_missing:${config.instrument}`,
            protectionOrderIds,
        }
    }

    if (config.requireTakeProfit && position.takeProfit === undefined) {
        return {
            ok: false,
            reason: `take_profit_missing:${config.instrument}`,
            protectionOrderIds,
        }
    }

    return {
        ok: true,
        protectionOrderIds,
    }
}

async function ensureProtectionOrders(config: {
    pipeline: ExecutionPipeline
    venue: OKXVenueAdapter
    instrument: string
    stopLoss: number
    takeProfit: number
    side: "buy" | "sell"
    quantity: number
    dryRun?: boolean
    status: string
    requireTakeProfit: boolean
    callbacks?: OKXExecutionSafetyCallbacks
    signal?: AbortSignal
}): Promise<{
    cancelledOrderIds: string[]
    createdOrderIds: string[]
    category?: OKXProtectionFailureCategory
    flattened?: boolean
    error?: string
}> {
    assertToolNotAborted(config.signal)

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
    let lastCategory: OKXProtectionFailureCategory | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
        let verification: Awaited<ReturnType<typeof verifyProtectionFromProviderTruth>>
        try {
            verification = await verifyProtectionFromProviderTruth({
                venue: config.venue,
                instrument: config.instrument,
                requireTakeProfit: config.requireTakeProfit,
                signal: config.signal,
            })
        } catch (error) {
            const message = `Protection verification failed: provider truth read failed for ${config.instrument}: ${error instanceof Error ? error.message : String(error)}`
            const protectionContext = await createOKXProtectionOperationContext(config)
            assertToolNotAborted(config.signal)
            const fault = await flattenOKXPositionAfterProtectionFailure({
                pipeline: config.pipeline,
                instrument: config.instrument,
                protectionError: message,
                category: classifyOKXProtectionFailure(message),
                flattenReason: "Protection verification failed after entry fill; flattening to fail closed",
                callbacks: config.callbacks,
                providerPayload: {
                    phase: "verifyAttachedProtection",
                    intendedStopLoss: config.stopLoss,
                    intendedTakeProfit: config.takeProfit,
                    verificationError: error instanceof Error ? error.message : String(error),
                },
                canonicalOrderId: protectionContext.identity.canonicalOrderId,
                providerClientOrderId: protectionContext.identity.providerClientOrderId,
                providerOrderAliases: protectionContext.identity.providerOrderAliases,
                submitAttemptId: protectionContext.identity.submitAttemptId,
                submitAttemptSequence: protectionContext.identity.submitAttemptSequence,
                venue: "okx-swap",
                signal: config.signal,
            })

            return {
                cancelledOrderIds: [],
                createdOrderIds: [],
                category: fault.category,
                flattened: fault.flattened,
                error: fault.error,
            }
        }
        if (verification.ok) {
            await config.callbacks?.resolveFaults?.({
                instrument: config.instrument,
                resolutionNote: "Attached OKX protection verified from provider truth after entry fill",
            })

            return {
                cancelledOrderIds: [],
                createdOrderIds: verification.protectionOrderIds,
            }
        }

        lastError = verification.reason
        lastCategory = classifyOKXProtectionFailure(verification.reason ?? "unknown")

        if (attempt < 2) {
            await delay((attempt + 1) * 500, config.signal)
        }
    }

    const protectionContext = await createOKXProtectionOperationContext(config)
    assertToolNotAborted(config.signal)

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            assertToolNotAborted(config.signal)
            const updated = await config.venue.updateProtectionOrders({
                instrument: config.instrument,
                stopLoss: config.stopLoss,
                takeProfit: config.takeProfit,
                identity: protectionContext.identity,
            })
            assertToolNotAborted(config.signal)
            const verification = await verifyProtectionFromProviderTruth({
                venue: config.venue,
                instrument: config.instrument,
                requireTakeProfit: config.requireTakeProfit,
                signal: config.signal,
            })
            if (!verification.ok) {
                lastError = verification.reason
                lastCategory = classifyOKXProtectionFailure(verification.reason ?? "unknown")
                if (attempt < 2) {
                    await delay((attempt + 1) * 500, config.signal)
                    continue
                }
                break
            }
            await config.callbacks?.resolveFaults?.({
                instrument: config.instrument,
                resolutionNote: "Protection verified from provider truth after entry fill",
            })

            return {
                cancelledOrderIds: updated.cancelledOrderIds,
                createdOrderIds: updated.createdOrderIds,
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            lastCategory = classifyOKXProtectionFailure(lastError)
            const shouldRetry = lastCategory === "position_not_found_yet"

            if (!shouldRetry || attempt === 2) {
                break
            }

            await delay((attempt + 1) * 500, config.signal)
        }
    }

    assertToolNotAborted(config.signal)
    const fault = await flattenOKXPositionAfterProtectionFailure({
        pipeline: config.pipeline,
        instrument: config.instrument,
        protectionError: lastError ?? "Failed to update protection orders",
        category: lastCategory,
        flattenReason: "Protection attachment failed; flattening to fail closed",
        callbacks: config.callbacks,
        providerPayload: {
            phase: "updateProtectionOrders",
            intendedStopLoss: config.stopLoss,
            intendedTakeProfit: config.takeProfit,
            updateError: lastError,
        },
        canonicalOrderId: protectionContext.identity.canonicalOrderId,
        providerClientOrderId: protectionContext.identity.providerClientOrderId,
        providerOrderAliases: protectionContext.identity.providerOrderAliases,
        submitAttemptId: protectionContext.identity.submitAttemptId,
        submitAttemptSequence: protectionContext.identity.submitAttemptSequence,
        venue: "okx-swap",
        signal: config.signal,
    })

    return {
        cancelledOrderIds: [],
        createdOrderIds: [],
        category: fault.category,
        flattened: fault.flattened,
        error: fault.error,
    }
}

async function createOKXProtectionOperationContext(config: {
    pipeline: Pick<ExecutionPipeline, "createExecutionOperationContext">
    instrument: string
    side: "buy" | "sell"
    quantity: number
    stopLoss: number
    takeProfit: number
    signal?: AbortSignal
}): Promise<SubmitOrderContext> {
    assertToolNotAborted(config.signal)
    const protectionIntent: OrderIntent = {
        instrument: config.instrument,
        side: config.side === "buy" ? "sell" : "buy",
        quantity: config.quantity,
        orderType: "stop_limit",
        stopPrice: config.stopLoss,
        limitPrice: config.takeProfit,
        timeInForce: "gtc",
        metadata: {
            action: "modify",
            protectionUpdate: true,
            stopLoss: config.stopLoss,
            takeProfit: config.takeProfit,
        },
    }

    const context = await config.pipeline.createExecutionOperationContext(
        protectionIntent,
        "modify"
    )
    assertToolNotAborted(config.signal)
    return context
}

export async function flattenOKXPositionAfterProtectionFailure(config: {
    pipeline: Pick<ExecutionPipeline, "closePosition">
    instrument: string
    protectionError: string
    category?: OKXProtectionFailureCategory
    flattenReason: string
    callbacks?: OKXExecutionSafetyCallbacks
    providerPayload?: Record<string, unknown>
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    venue?: string
    recoveryProbeEvidence?: Record<string, unknown>
    signal?: AbortSignal
}): Promise<{
    category: OKXProtectionFailureCategory
    flattened: boolean
    error: string
}> {
    const faultCategory = config.category ?? classifyOKXProtectionFailure(config.protectionError)
    const faultMessage = config.protectionError

    try {
        assertToolNotAborted(config.signal)
        const flattenResult = await config.pipeline.closePosition(
            config.instrument,
            config.flattenReason,
            {
                metadata: {
                    forcedExit: true,
                    executionSafetyCategory: faultCategory,
                    executionSafetyReason: faultMessage,
                },
            }
        )
        assertToolNotAborted(config.signal)
        if (flattenResult.result.status !== "filled") {
            throw new Error(flattenResult.result.error ?? `Flatten did not prove flat position: ${flattenResult.result.status}`)
        }
    } catch (flattenError) {
        const flattenMessage = flattenError instanceof Error ? flattenError.message : String(flattenError)
        const combinedMessage = `${faultMessage}; flatten_failed=${flattenMessage}`
        assertToolNotAborted(config.signal)
        await config.callbacks?.recordFault?.({
            instrument: config.instrument,
            category: faultCategory,
            message: combinedMessage,
            providerPayload: JSON.stringify({
                ...config.providerPayload,
                protectionError: faultMessage,
                flattenError: flattenMessage,
            }),
            canonicalOrderId: config.canonicalOrderId,
            providerOrderId: config.providerOrderId,
            providerClientOrderId: config.providerClientOrderId,
            providerOrderAliases: config.providerOrderAliases,
            submitAttemptId: config.submitAttemptId,
            submitAttemptSequence: config.submitAttemptSequence,
            venue: config.venue,
            recoveryProbeEvidence: config.recoveryProbeEvidence,
        })

        return {
            category: faultCategory,
            flattened: false,
            error: combinedMessage,
        }
    }

    assertToolNotAborted(config.signal)
    await config.callbacks?.recordFault?.({
        instrument: config.instrument,
        category: faultCategory,
        message: faultMessage,
        providerPayload: JSON.stringify({
            ...config.providerPayload,
            protectionError: faultMessage,
        }),
        canonicalOrderId: config.canonicalOrderId,
        providerOrderId: config.providerOrderId,
        providerClientOrderId: config.providerClientOrderId,
        providerOrderAliases: config.providerOrderAliases,
        submitAttemptId: config.submitAttemptId,
        submitAttemptSequence: config.submitAttemptSequence,
        venue: config.venue,
        recoveryProbeEvidence: config.recoveryProbeEvidence,
    })

    return {
        category: faultCategory,
        flattened: true,
        error: `${faultMessage}. Position was flattened to fail closed.`,
    }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    assertToolNotAborted(signal)

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(createToolAbortError())
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}
