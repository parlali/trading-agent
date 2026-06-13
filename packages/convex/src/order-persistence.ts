import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import type {
    OrderLifecycleAlert,
    OrderPersistenceAdapter,
    OrderSnapshot,
    OrderTransition,
} from "@valiq-trading/core"
import type { ConvexOrderPersistenceConfig } from "./client-types"
import { createMachineConvexHttpContext } from "./convex-http"

function normalizeOrderSnapshot(snapshot: OrderSnapshot | null): OrderSnapshot | null {
    if (!snapshot) {
        return null
    }

    return {
        ...snapshot,
        canonicalOrderId: snapshot.canonicalOrderId ?? snapshot.orderId,
        providerOrderId: snapshot.providerOrderId ?? snapshot.orderId,
        providerClientOrderId: snapshot.providerClientOrderId,
        providerOrderAliases: snapshot.providerOrderAliases ?? [],
        submitAttemptId: snapshot.submitAttemptId,
        submitAttemptSequence: snapshot.submitAttemptSequence,
        commitOutcome: snapshot.commitOutcome ?? "accepted",
        signedOrderFingerprint: snapshot.signedOrderFingerprint,
        signedOrderMetadata: snapshot.signedOrderMetadata,
        lastTransitionSequence: snapshot.lastTransitionSequence ?? 0,
    }
}

export const createConvexOrderPersistenceAdapter = (
    config: ConvexOrderPersistenceConfig
): OrderPersistenceAdapter => {
    const { client, requireMachineAuth, runWithTimeout } = createMachineConvexHttpContext(
        config,
        "Order persistence adapter requires a backend service token"
    )

    return {
        async upsertOrder(snapshot: OrderSnapshot): Promise<void> {
            await runWithTimeout(
                "Convex mutation upsertOrder",
                async () => await client.mutation(api.mutations.upsertOrder, {
                    ...requireMachineAuth(),
                    orderId: snapshot.orderId,
                    canonicalOrderId: snapshot.canonicalOrderId,
                    providerOrderId: snapshot.providerOrderId,
                    providerClientOrderId: snapshot.providerClientOrderId,
                    providerOrderAliases: snapshot.providerOrderAliases,
                    submitAttemptId: snapshot.submitAttemptId,
                    submitAttemptSequence: snapshot.submitAttemptSequence,
                    commitOutcome: snapshot.commitOutcome,
                    signedOrderFingerprint: snapshot.signedOrderFingerprint,
                    signedOrderMetadata: snapshot.signedOrderMetadata,
                    runId: snapshot.runId as Id<"strategy_runs">,
                    strategyId: snapshot.strategyId as Id<"strategies">,
                    accountId: snapshot.accountId,
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
                    lastTransitionSequence: snapshot.lastTransitionSequence,
                    polling: snapshot.polling,
                })
            )
        },
        async logOrderTransition(transition: OrderTransition): Promise<number> {
            return await runWithTimeout(
                "Convex mutation logOrderTransition",
                async () => await client.mutation(api.mutations.logOrderTransition, {
                    ...requireMachineAuth(),
                    orderId: transition.orderId,
                    runId: transition.runId as Id<"strategy_runs">,
                    strategyId: transition.strategyId as Id<"strategies">,
                    type: transition.type,
                    status: transition.status,
                    previousStatus: transition.previousStatus,
                    reason: transition.reason,
                    details: transition.details,
                    timestamp: transition.timestamp,
                })
            )
        },
        async getOrder(orderId: string): Promise<OrderSnapshot | null> {
            const order = await runWithTimeout(
                "Convex query getOrderById",
                async () => await client.query(api.queries.getOrderById, {
                    ...requireMachineAuth(),
                    orderId,
                    app: config.orderLookupScope?.app,
                    accountId: config.orderLookupScope?.accountId,
                    strategyId: config.orderLookupScope?.strategyId as Id<"strategies"> | undefined,
                })
            )
            return normalizeOrderSnapshot(order as OrderSnapshot | null)
        },
        async listActiveOrders(strategyId: string): Promise<OrderSnapshot[]> {
            const orders = await runWithTimeout(
                "Convex query getActiveOrders",
                async () => await client.query(api.queries.getActiveOrders, {
                    ...requireMachineAuth(),
                    strategyId: strategyId as Id<"strategies">,
                })
            )
            return (orders as OrderSnapshot[])
                .map((order) => normalizeOrderSnapshot(order))
                .filter((order): order is OrderSnapshot => order !== null)
        },
        async createAlert(alert: OrderLifecycleAlert): Promise<void> {
            await runWithTimeout(
                "Convex mutation createAlert(orderLifecycle)",
                async () => await client.mutation(api.mutations.createAlert, {
                    ...requireMachineAuth(),
                    strategyId: alert.strategyId as Id<"strategies">,
                    severity: alert.severity,
                    message: alert.message,
                })
            )
        },
    }
}
