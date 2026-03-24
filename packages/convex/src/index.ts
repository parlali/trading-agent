import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import type { OrderLifecycleAlert, OrderPersistenceAdapter, OrderSnapshot, OrderTransition } from "@valiq-trading/core"

export { api }
export type { Id } from "../convex/_generated/dataModel"

export interface ConvexOrderPersistenceConfig {
    url: string
}

export const createConvexOrderPersistenceAdapter = (
    config: ConvexOrderPersistenceConfig
): OrderPersistenceAdapter => {
    const client = new ConvexHttpClient(config.url)

    return {
        async upsertOrder(snapshot: OrderSnapshot): Promise<void> {
            await client.mutation(api.mutations.upsertOrder, {
                orderId: snapshot.orderId,
                runId: snapshot.runId as Id<"strategy_runs">,
                strategyId: snapshot.strategyId as Id<"strategies">,
                venue: snapshot.venue,
                instrument: snapshot.instrument,
                status: snapshot.status,
                action: snapshot.action,
                quantity: snapshot.quantity,
                filledQuantity: snapshot.filledQuantity,
                remainingQuantity: snapshot.remainingQuantity,
                avgFillPrice: snapshot.avgFillPrice,
                submittedAt: snapshot.submittedAt,
                updatedAt: snapshot.updatedAt,
                intent: snapshot.intent,
                metadata: snapshot.metadata,
                polling: snapshot.polling,
            })
        },
        async logOrderTransition(transition: OrderTransition): Promise<void> {
            await client.mutation(api.mutations.logOrderTransition, {
                orderId: transition.orderId,
                runId: transition.runId as Id<"strategy_runs">,
                strategyId: transition.strategyId as Id<"strategies">,
                sequence: transition.sequence,
                type: transition.type,
                status: transition.status,
                previousStatus: transition.previousStatus,
                reason: transition.reason,
                details: transition.details,
                timestamp: transition.timestamp,
            })
        },
        async getOrder(orderId: string): Promise<OrderSnapshot | null> {
            const order = await client.query(api.queries.getOrderById, { orderId })
            return order as OrderSnapshot | null
        },
        async listActiveOrders(strategyId: string): Promise<OrderSnapshot[]> {
            const orders = await client.query(api.queries.getActiveOrders, {
                strategyId: strategyId as Id<"strategies">,
            })
            return orders as OrderSnapshot[]
        },
        async createAlert(alert: OrderLifecycleAlert): Promise<void> {
            await client.mutation(api.mutations.createAlert, {
                strategyId: alert.strategyId as Id<"strategies">,
                severity: alert.severity,
                message: alert.message,
            })
        },
    }
}
