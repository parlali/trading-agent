import type { AccountState, ExecutionResult, OrderIntent, Position } from "./types"
import type { DryRunOrderSimulator, SubmitOrderContext, VenueAdapter } from "./execution-contracts"
import {
    buildDryRunAccountState,
    createDryRunAccountLedgerPosition,
    isDryRunAccountLedgerPosition,
    resolveDryRunCashDelta,
    resolveDryRunCurrentPrice,
    resolveDryRunNotionalMultiplier,
    resolveDryRunOpeningCashDelta,
    resolveDryRunRealizedPnl,
    resolveDryRunUnrealizedPnl,
} from "./dry-run-ledger"
import {
    orderSideForPositionSide,
    readNumber,
} from "./execution-metadata"
import { createExecutionErrorDetail, createExecutionError, formatExecutionError } from "./utils"

export class DryRunExecutionBook {
    private positions = new Map<string, Position>()
    private cashAdjustment = 0
    private realizedPnl = 0

    constructor(
        private readonly policy: Record<string, unknown>,
        private readonly runId: string
    ) {}

    seedPositions(positions: Position[]): void {
        this.positions.clear()
        this.cashAdjustment = 0
        this.realizedPnl = 0
        const ledger = positions.find((position) => isDryRunAccountLedgerPosition(position))
        if (ledger) {
            this.cashAdjustment = readNumber(ledger.metadata?.cashAdjustment) ?? 0
            this.realizedPnl = readNumber(ledger.metadata?.realizedPnl) ?? 0
        }

        for (const position of positions) {
            if (isDryRunAccountLedgerPosition(position)) {
                continue
            }

            this.positions.set(position.instrument, position)
            if (!ledger) {
                this.cashAdjustment += resolveDryRunOpeningCashDelta(position)
            }
        }
    }

    getPositions(): Position[] {
        return Array.from(this.positions.values())
    }

    getPositionsForSync(): Position[] {
        return [
            ...this.getPositions(),
            this.createAccountLedgerPosition(),
        ]
    }

    getAccountState(): AccountState {
        return buildDryRunAccountState({
            policy: this.policy,
            positions: this.getPositions(),
            cashAdjustment: this.cashAdjustment,
            realizedPnl: this.realizedPnl,
        })
    }

    netPosition(
        instrument: string,
        side: "buy" | "sell",
        quantity: number,
        fillPrice: number,
        action: string,
        metadata?: Record<string, unknown>,
        result?: ExecutionResult
    ): void {
        if (action !== "entry" && action !== "adjustment" && action !== "close") {
            return
        }
        const positionSide = side === "buy" ? "long" : "short"
        const existing = this.positions.get(instrument)
        const multiplier = resolveDryRunNotionalMultiplier(instrument, metadata)
        const fillFee = resolveDryRunFillFee(result)
        if (!existing) {
            if (action === "close") {
                return
            }
            this.applyFillFee(fillFee)
            this.cashAdjustment += resolveDryRunCashDelta(side, quantity, fillPrice, multiplier)
            const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? fillPrice
            this.positions.set(instrument, {
                instrument,
                side: positionSide,
                quantity,
                entryPrice: fillPrice,
                currentPrice,
                unrealizedPnl: resolveDryRunUnrealizedPnl(positionSide, quantity, fillPrice, currentPrice, multiplier),
                metadata: this.buildPositionMetadata(metadata, side, quantity, fillPrice, currentPrice, result),
            })
            return
        }
        this.applyFillFee(fillFee)
        if (existing.side === positionSide) {
            const existingMultiplier = resolveDryRunNotionalMultiplier(existing.instrument, existing.metadata)
            this.cashAdjustment += resolveDryRunCashDelta(side, quantity, fillPrice, existingMultiplier)
            const totalQty = existing.quantity + quantity
            const avgEntry = (existing.quantity * existing.entryPrice + quantity * fillPrice) / totalQty
            const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? existing.currentPrice
            this.positions.set(instrument, {
                ...existing,
                quantity: totalQty,
                entryPrice: avgEntry,
                currentPrice,
                unrealizedPnl: resolveDryRunUnrealizedPnl(existing.side, totalQty, avgEntry, currentPrice, existingMultiplier),
                metadata: this.buildPositionMetadata(
                    {
                        ...existing.metadata,
                        ...metadata,
                    },
                    side,
                    totalQty,
                    avgEntry,
                    currentPrice,
                    result
                ),
            })
        } else {
            const existingMultiplier = resolveDryRunNotionalMultiplier(existing.instrument, existing.metadata)
            const effectiveQuantity = action === "close" ? Math.min(existing.quantity, quantity) : quantity
            this.cashAdjustment += resolveDryRunCashDelta(side, effectiveQuantity, fillPrice, existingMultiplier)
            const closedQty = Math.min(existing.quantity, effectiveQuantity)
            this.realizedPnl += resolveDryRunRealizedPnl(existing, side, closedQty, fillPrice)
            const netQty = existing.quantity - effectiveQuantity
            if (netQty === 0) {
                this.positions.delete(instrument)
            } else if (netQty > 0) {
                const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? existing.currentPrice
                const remainingSide = orderSideForPositionSide(existing.side)
                this.positions.set(instrument, {
                    ...existing,
                    quantity: netQty,
                    currentPrice,
                    unrealizedPnl: resolveDryRunUnrealizedPnl(existing.side, netQty, existing.entryPrice, currentPrice, existingMultiplier),
                    metadata: this.buildPositionMetadata(
                        {
                            ...existing.metadata,
                            ...metadata,
                        },
                        remainingSide,
                        netQty,
                        existing.entryPrice,
                        currentPrice,
                        result
                    ),
                })
            } else {
                const flippedQty = Math.abs(netQty)
                const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? fillPrice
                this.positions.set(instrument, {
                    instrument,
                    side: positionSide,
                    quantity: flippedQty,
                    entryPrice: fillPrice,
                    currentPrice,
                    unrealizedPnl: resolveDryRunUnrealizedPnl(positionSide, flippedQty, fillPrice, currentPrice, multiplier),
                    metadata: this.buildPositionMetadata(metadata, side, flippedQty, fillPrice, currentPrice, result),
                })
            }
        }
    }

    private applyFillFee(fee: number | undefined): void {
        if (fee === undefined) {
            return
        }

        this.cashAdjustment += fee
        this.realizedPnl += fee
    }

    private buildPositionMetadata(
        metadata: Record<string, unknown> | undefined,
        side: "buy" | "sell",
        quantity: number,
        entryPrice: number,
        currentPrice: number | undefined,
        result?: ExecutionResult
    ): Record<string, unknown> {
        return {
            ...metadata,
            side,
            quantity,
            entryPrice,
            currentPrice,
            sourceOrderId: result?.orderId,
            sourceRunId: this.runId,
        }
    }

    private createAccountLedgerPosition(): Position {
        return createDryRunAccountLedgerPosition({
            policy: this.policy,
            positions: this.getPositions(),
            cashAdjustment: this.cashAdjustment,
            realizedPnl: this.realizedPnl,
            runId: this.runId,
        })
    }
}

export async function simulateDryRunOrder(
    venue: VenueAdapter,
    intent: OrderIntent,
    context?: SubmitOrderContext
): Promise<ExecutionResult> {
    if (!context?.identity.canonicalOrderId) {
        throw createExecutionError("pre_validation", "Dry-run execution requires canonical execution identity", {
            code: "MISSING_CANONICAL_ORDER_ID",
            retryable: false,
            details: {
                instrument: intent.instrument,
            },
        })
    }

    if (hasDryRunOrderSimulator(venue)) {
        return await venue.simulateDryRunOrder(intent, context)
    }

    const fillPrice = intent.limitPrice ?? (intent.metadata?.estimatedPrice as number | undefined)
    if (fillPrice === undefined || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        const errorDetail = createExecutionErrorDetail("pre_validation", "Dry-run order simulation requires a positive limitPrice or estimatedPrice", {
            code: "DRY_RUN_PRICE_REQUIRED",
            retryable: false,
            details: {
                instrument: intent.instrument,
                orderType: intent.orderType,
            },
        })
        return {
            orderId: context.identity.canonicalOrderId,
            canonicalOrderId: context.identity.canonicalOrderId,
            providerClientOrderId: context.identity.providerClientOrderId,
            commitOutcome: "accepted",
            submitAttemptId: context.identity.submitAttemptId,
            submitAttemptSequence: context.identity.submitAttemptSequence,
            status: "rejected",
            filledQuantity: 0,
            timestamp: Date.now(),
            error: formatExecutionError(errorDetail),
            errorDetail,
        }
    }

    return {
        orderId: context.identity.canonicalOrderId,
        canonicalOrderId: context.identity.canonicalOrderId,
        providerClientOrderId: context.identity.providerClientOrderId,
        commitOutcome: "accepted",
        submitAttemptId: context.identity.submitAttemptId,
        submitAttemptSequence: context.identity.submitAttemptSequence,
        status: "filled",
        filledQuantity: intent.quantity,
        fillPrice,
        timestamp: Date.now(),
    }
}

function hasDryRunOrderSimulator(venue: VenueAdapter): venue is VenueAdapter & DryRunOrderSimulator {
    return typeof (venue as Partial<DryRunOrderSimulator>).simulateDryRunOrder === "function"
}

function resolveDryRunFillFee(result: ExecutionResult | undefined): number | undefined {
    const fee = readNumber(result?.intentUpdates?.metadata?.fee)
    return fee !== undefined && Number.isFinite(fee) ? fee : undefined
}
