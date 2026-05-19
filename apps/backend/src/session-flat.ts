import type {
    ExecuteIntentResult,
    ExecutionResult,
    Logger,
    Position,
    WorkingOrder,
} from "@valiq-trading/core"
import {
    isAlpacaRawOptionLegPosition,
    resolveAlpacaCloseGroupsFromPositions,
} from "@valiq-trading/alpaca-options"

export interface AuditedSessionFlatPipeline {
    cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult>
    closeProviderPosition(position: Position, reason?: string, options?: {
        metadata?: Record<string, unknown>
    }): Promise<ExecuteIntentResult>
}

export interface AuditedSessionFlatResult {
    cancelled: number
    closed: number
    cancelResults: ExecutionResult[]
    closeResults: ExecutionResult[]
}

export async function executeAuditedSessionFlat(args: {
    pipeline: AuditedSessionFlatPipeline
    logger: Logger
    strategyId: string
    app: string
    positions: Position[]
    workingOrders: WorkingOrder[]
    reason: string
}): Promise<AuditedSessionFlatResult> {
    const cancelResults: ExecutionResult[] = []
    const closeResults: ExecutionResult[] = []

    for (const order of args.workingOrders) {
        const result = await args.pipeline.cancelOrder(order.orderId, args.reason)
        cancelResults.push(result)
    }

    for (const position of resolveAlpacaCloseGroupsFromPositions(args.positions)) {
        if (args.app === "alpaca-options" && isAlpacaRawOptionLegPosition(position)) {
            closeResults.push({
                orderId: position.providerPositionId ?? position.instrument,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: "Alpaca raw option leg close requires complete claimed structure evidence",
            })
            continue
        }

        const { result } = await args.pipeline.closeProviderPosition(position, args.reason, {
            metadata: {
                sessionFlat: true,
                sessionFlatApp: args.app,
                providerPositionId: position.providerPositionId,
            },
        })
        closeResults.push(result)
    }

    const cancelled = cancelResults.filter((result) =>
        result.status === "cancelled" || result.status === "filled"
    ).length
    const closed = closeResults.filter((result) => result.status === "filled").length
    const failedCancels = cancelResults.filter((result) =>
        result.status !== "cancelled" && result.status !== "filled"
    )
    const failedCloses = closeResults.filter((result) => result.status !== "filled")

    args.logger.info("Audited session-flat execution completed", {
        strategyId: args.strategyId,
        app: args.app,
        cancelled,
        closed,
        cancelResultCount: cancelResults.length,
        closeResultCount: closeResults.length,
    })

    if (failedCancels.length > 0 || failedCloses.length > 0) {
        args.logger.error("Audited session-flat execution failed closed", {
            strategyId: args.strategyId,
            app: args.app,
            failedCancelOrderIds: failedCancels.map((result) => result.orderId),
            failedCloseOrderIds: failedCloses.map((result) => result.orderId),
        })

        throw new Error(
            `Audited session-flat failed for ${args.app}: ${failedCancels.length} cancel(s) and ${failedCloses.length} close(s) did not reach a terminal safe state`
        )
    }

    return {
        cancelled,
        closed,
        cancelResults,
        closeResults,
    }
}
