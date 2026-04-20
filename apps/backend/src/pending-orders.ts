import {
    isTerminalOrderStatus,
    type Logger,
    type OrderSnapshot,
    type PendingOrderContext,
} from "@valiq-trading/core"

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

function buildPendingOrderContext(snapshot: OrderSnapshot): PendingOrderContext {
    const cancelAt = readFiniteNumber(snapshot.intent.metadata?.cancelAt)
    return {
        orderId: snapshot.orderId,
        instrument: snapshot.instrument,
        action: snapshot.action,
        status: snapshot.status,
        quantity: snapshot.quantity,
        filledQuantity: snapshot.filledQuantity,
        remainingQuantity: snapshot.remainingQuantity,
        submittedAt: snapshot.submittedAt,
        updatedAt: snapshot.updatedAt,
        cancelAt,
        limitPrice: snapshot.intent.limitPrice,
        avgFillPrice: snapshot.avgFillPrice,
        recommendedAction: getPendingOrderRecommendedAction(snapshot),
    }
}

function getPendingOrderRecommendedAction(snapshot: OrderSnapshot): string {
    const cancelAt = readFiniteNumber(snapshot.intent.metadata?.cancelAt)
    if (cancelAt !== undefined && cancelAt <= Date.now()) {
        return "This working order exceeded its configured TTL and should be cancelled before any new entries."
    }

    if (snapshot.status === "partially_filled") {
        return "Review the remaining quantity immediately. Decide whether to keep working the remainder, improve the price, or cancel the rest."
    }

    if (snapshot.polling.timedOutAt) {
        return "Refresh this order first. The prior run handed it off after its wait window expired while the venue order was still live."
    }

    return "Refresh the working order, then either keep waiting, improve the limit price, or cancel if the thesis or session conditions changed."
}

interface PendingOrderPipeline {
    cancelOrder(orderId: string, reason?: string): Promise<{ status: string }>
    getOrderStatus(orderId: string): Promise<unknown>
    getOrderSnapshot(orderId: string): Promise<OrderSnapshot | null>
    resumeOpenOrders(onUpdate: () => { decision: "wait" }): Promise<unknown>
}

interface PendingOrderPersistence {
    listActiveOrders(strategyId: string): Promise<OrderSnapshot[]>
}

export async function reconcilePendingOrdersForRun(
    pipeline: PendingOrderPipeline,
    strategyId: string,
    orderPersistence: PendingOrderPersistence,
    runLogger: Logger
): Promise<{ pendingOrders: PendingOrderContext[]; runtimeContextLines: string[] }> {
    const persistedActiveOrders = await orderPersistence.listActiveOrders(strategyId)
    if (persistedActiveOrders.length === 0) {
        return {
            pendingOrders: [],
            runtimeContextLines: [],
        }
    }

    const pendingOrders: PendingOrderContext[] = []
    const runtimeContextLines: string[] = []

    for (const persistedOrder of persistedActiveOrders) {
        const cancelAt = readFiniteNumber(persistedOrder.intent.metadata?.cancelAt)
        if (cancelAt !== undefined && cancelAt <= Date.now()) {
            try {
                const cancellation = await pipeline.cancelOrder(
                    persistedOrder.orderId,
                    "Provider working-order TTL expired"
                )
                runLogger.info("Cancelled expired pending order by TTL", {
                    orderId: persistedOrder.orderId,
                    status: cancellation.status,
                    cancelAt,
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                runLogger.warn("Failed to cancel expired pending order by TTL", {
                    orderId: persistedOrder.orderId,
                    cancelAt,
                    error: message,
                })
                runtimeContextLines.push(
                    `TTL cancellation failed for ${persistedOrder.orderId}. Refresh venue status before placing any new entries on this instrument.`
                )
            }
            continue
        }

        try {
            await pipeline.getOrderStatus(persistedOrder.orderId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            runLogger.warn("Failed to refresh persisted active order before run", {
                orderId: persistedOrder.orderId,
                error: message,
            })
            runtimeContextLines.push(
                `Active order refresh failed at run start for ${persistedOrder.orderId}. Do not trust the stored snapshot without a successful venue refresh.`
            )
            continue
        }

        const refreshedSnapshot = await pipeline.getOrderSnapshot(persistedOrder.orderId)
        if (!refreshedSnapshot || isTerminalOrderStatus(refreshedSnapshot.status)) {
            continue
        }

        pendingOrders.push(buildPendingOrderContext(refreshedSnapshot))
    }

    if (pendingOrders.length > 0) {
        await pipeline.resumeOpenOrders(() => ({ decision: "wait" }))
    }

    return {
        pendingOrders,
        runtimeContextLines,
    }
}

export const pendingOrderGovernanceTestables = {
    buildPendingOrderContext,
    getPendingOrderRecommendedAction,
}
