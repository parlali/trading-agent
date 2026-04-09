import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { withTimeout } from "@valiq-trading/core";
export { api };
export function toKillSwitchKey(app) {
    return app.replace(/-/g, "_");
}
export const createTradingBackendClient = (config) => {
    const resolvedConfig = typeof config === "string"
        ? { url: config }
        : config;
    const client = new ConvexHttpClient(resolvedConfig.url);
    const timeoutMs = resolvedConfig.timeoutMs ?? 30_000;
    const requireMachineAuth = () => {
        const serviceToken = resolvedConfig.machineAuth?.serviceToken?.trim();
        if (!serviceToken) {
            throw new Error("Machine-authenticated Convex call requires a backend service token");
        }
        return { serviceToken };
    };
    const runWithTimeout = async (name, operation) => {
        return await withTimeout(operation, timeoutMs, name);
    };
    return {
        async getStrategyConfigs(app) {
            return await runWithTimeout("Convex query getStrategyConfigs", async () => await client.query(api.queries.getStrategyConfigs, { ...requireMachineAuth(), app }));
        },
        async getStrategyById(id) {
            return await runWithTimeout("Convex query getStrategyById", async () => await client.query(api.queries.getStrategyById, { ...requireMachineAuth(), id }));
        },
        async getActiveRun(strategyId) {
            return await runWithTimeout("Convex query getActiveRun", async () => await client.query(api.queries.getActiveRun, {
                ...requireMachineAuth(),
                strategyId,
            }));
        },
        async getLastCompletedRunSummary(strategyId) {
            return await runWithTimeout("Convex query getLastCompletedRunSummary", async () => await client.query(api.queries.getLastCompletedRunSummary, { ...requireMachineAuth(), strategyId }));
        },
        async recoverRunningRuns() {
            const result = await runWithTimeout("Convex mutation recoverRunningRuns", async () => await client.mutation(api.mutations.recoverRunningRuns, {
                ...requireMachineAuth(),
            }));
            return result.recovered;
        },
        async recoverStaleRunningRuns(olderThanMs) {
            const result = await runWithTimeout("Convex mutation recoverStaleRunningRuns", async () => await client.mutation(api.mutations.recoverStaleRunningRuns, {
                ...requireMachineAuth(),
                olderThanMs,
            }));
            return result.recovered;
        },
        async createRun(strategyId, app, trigger) {
            return await runWithTimeout("Convex mutation createRun", async () => await client.mutation(api.mutations.createRun, {
                ...requireMachineAuth(),
                strategyId,
                app,
                trigger,
            }));
        },
        async recordRunCallback(runId, callbackRequestedMinutes, callbackFiresAt) {
            await runWithTimeout("Convex mutation recordRunCallback", async () => await client.mutation(api.mutations.recordRunCallback, {
                ...requireMachineAuth(),
                runId,
                callbackRequestedMinutes,
                callbackFiresAt,
            }));
        },
        async updateRun(runId, status, summary, error) {
            await runWithTimeout("Convex mutation updateRun", async () => await client.mutation(api.mutations.updateRun, {
                ...requireMachineAuth(),
                runId,
                status,
                summary,
                error,
            }));
        },
        async log(runId, strategyId, sequence, role, content, toolName, toolInput, toolOutput) {
            if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
                throw new Error(`Unsupported agent log role: ${role}`);
            }
            await runWithTimeout("Convex mutation logAgentMessage", async () => await client.mutation(api.mutations.logAgentMessage, {
                ...requireMachineAuth(),
                runId: runId,
                strategyId: strategyId,
                sequence,
                role,
                content,
                toolName,
                toolInput,
                toolOutput,
            }));
        },
        async logIntent(runId, strategyId, intent) {
            await runWithTimeout("Convex mutation logTradeEvent(intent)", async () => await client.mutation(api.mutations.logTradeEvent, {
                ...requireMachineAuth(),
                runId: runId,
                strategyId: strategyId,
                eventType: "intent",
                payload: JSON.stringify(intent),
            }));
        },
        async logValidation(runId, strategyId, result, intent) {
            await runWithTimeout("Convex mutation logTradeEvent(validation)", async () => await client.mutation(api.mutations.logTradeEvent, {
                ...requireMachineAuth(),
                runId: runId,
                strategyId: strategyId,
                eventType: result.allowed ? "validation" : "rejected",
                payload: JSON.stringify({ result, intent }),
            }));
        },
        async logSubmission(runId, strategyId, result, intent) {
            const action = intent.metadata?.action;
            const eventType = action === "modify"
                ? result.status === "rejected"
                    ? "rejected"
                    : "submission"
                : result.status === "filled"
                    ? "filled"
                    : result.status === "cancelled"
                        ? "cancelled"
                        : result.status === "rejected"
                            ? "rejected"
                            : "submission";
            await runWithTimeout("Convex mutation logTradeEvent(submission)", async () => await client.mutation(api.mutations.logTradeEvent, {
                ...requireMachineAuth(),
                runId: runId,
                strategyId: strategyId,
                eventType,
                payload: JSON.stringify({ result, intent }),
            }));
        },
        async logFillUpdate(runId, strategyId, result) {
            const eventType = result.status === "filled" ? "filled" : "fill_update";
            await runWithTimeout("Convex mutation logTradeEvent(fillUpdate)", async () => await client.mutation(api.mutations.logTradeEvent, {
                ...requireMachineAuth(),
                runId: runId,
                strategyId: strategyId,
                eventType,
                payload: JSON.stringify(result),
            }));
        },
        async syncPositions(strategyId, app, positions) {
            await runWithTimeout("Convex mutation syncPositions", async () => await client.mutation(api.mutations.syncPositions, {
                ...requireMachineAuth(),
                strategyId,
                app: app,
                positions: positions.map((position) => ({
                    instrument: position.instrument,
                    side: position.side,
                    quantity: position.quantity,
                    entryPrice: position.entryPrice,
                    currentPrice: position.currentPrice,
                    unrealizedPnl: position.unrealizedPnl,
                    metadata: position.metadata ? JSON.stringify(position.metadata) : undefined,
                })),
            }));
        },
        async reconcileProviderPortfolio(app, venue, source, accountState, positions, workingOrders) {
            return await runWithTimeout("Convex mutation reconcileProviderPortfolio", async () => await client.mutation(api.mutations.reconcileProviderPortfolio, {
                ...requireMachineAuth(),
                app,
                venue,
                source,
                accountState: {
                    balance: accountState.balance,
                    equity: accountState.equity,
                    buyingPower: accountState.buyingPower,
                    marginUsed: accountState.marginUsed,
                    marginAvailable: accountState.marginAvailable,
                    openPnl: accountState.openPnl,
                    dayPnl: accountState.dayPnl,
                },
                positions: positions.map((position) => ({
                    instrument: position.instrument,
                    side: position.side,
                    quantity: position.quantity,
                    entryPrice: position.entryPrice,
                    currentPrice: position.currentPrice,
                    unrealizedPnl: position.unrealizedPnl,
                    stopLoss: position.stopLoss,
                    takeProfit: position.takeProfit,
                    metadata: position.metadata ? JSON.stringify(position.metadata) : undefined,
                })),
                workingOrders: workingOrders.map((order) => ({
                    orderId: order.orderId,
                    instrument: order.instrument,
                    status: order.status,
                    quantity: order.quantity,
                    filledQuantity: order.filledQuantity,
                    remainingQuantity: order.remainingQuantity,
                    submittedAt: order.submittedAt,
                    updatedAt: order.updatedAt,
                    side: order.side,
                    limitPrice: order.limitPrice,
                    stopPrice: order.stopPrice,
                    avgFillPrice: order.avgFillPrice,
                    metadata: order.metadata ? JSON.stringify(order.metadata) : undefined,
                })),
            }));
        },
        async recordProviderSyncFailure(app, error) {
            await runWithTimeout("Convex mutation recordProviderSyncFailure", async () => await client.mutation(api.mutations.recordProviderSyncFailure, {
                ...requireMachineAuth(),
                app,
                error,
            }));
        },
        async resolveSecrets(keys) {
            return await runWithTimeout("Convex action resolveSecrets", async () => await client.action(api.actions.resolveSecrets, {
                keys,
                ...requireMachineAuth(),
            }));
        },
        async reportHeartbeat(app, status, metadata) {
            await runWithTimeout("Convex mutation reportHeartbeat", async () => await client.mutation(api.mutations.reportHeartbeat, {
                ...requireMachineAuth(),
                app,
                status,
                metadata,
            }));
        },
        async snapshotAccountState(app, venue, state) {
            await runWithTimeout("Convex mutation snapshotAccountState", async () => await client.mutation(api.mutations.snapshotAccountState, {
                ...requireMachineAuth(),
                app,
                venue,
                balance: state.balance,
                equity: state.equity,
                buyingPower: state.buyingPower,
                marginUsed: state.marginUsed,
                marginAvailable: state.marginAvailable,
                openPnl: state.openPnl,
                dayPnl: state.dayPnl,
            }));
        },
        async getSystemState() {
            return await runWithTimeout("Convex query getSystemState", async () => await client.query(api.queries.getSystemState, { ...requireMachineAuth() }));
        },
        async getPortfolioFreshness(app) {
            return await runWithTimeout("Convex query getPortfolioFreshness", async () => await client.query(api.queries.getPortfolioFreshness, {
                ...requireMachineAuth(),
                app,
            }));
        },
        async getPortfolioPositions(app, strategyId) {
            return await runWithTimeout("Convex query getPortfolioPositions", async () => await client.query(api.queries.getPortfolioPositions, {
                ...requireMachineAuth(),
                app,
                strategyId,
            }));
        },
        async getPortfolioPendingOrders(app, strategyId) {
            return await runWithTimeout("Convex query getPortfolioPendingOrders", async () => await client.query(api.queries.getPortfolioPendingOrders, {
                ...requireMachineAuth(),
                app,
                strategyId,
            }));
        },
        async getManualRunRequests(app) {
            return await runWithTimeout("Convex query getManualRunRequests", async () => await client.query(api.queries.getManualRunRequests, { ...requireMachineAuth(), app }));
        },
        async clearManualRunRequest(requestId) {
            await runWithTimeout("Convex mutation clearManualRunRequest", async () => await client.mutation(api.mutations.clearManualRunRequest, { ...requireMachineAuth(), requestId }));
        },
        async createAlert(args) {
            await runWithTimeout("Convex mutation createAlert", async () => await client.mutation(api.mutations.createAlert, {
                ...requireMachineAuth(),
                strategyId: args.strategyId,
                app: args.app,
                severity: args.severity,
                message: args.message,
            }));
        },
        async triggerManualRun(strategyId) {
            return await runWithTimeout("Convex mutation triggerManualRun", async () => await client.mutation(api.mutations.triggerManualRun, { strategyId }));
        },
        async acknowledgeAlert(alertId) {
            await runWithTimeout("Convex mutation acknowledgeAlert", async () => await client.mutation(api.mutations.acknowledgeAlert, { alertId }));
        },
        async getStrategyOwnedInstruments(strategyId) {
            return await runWithTimeout("Convex query getStrategyOwnedInstruments", async () => await client.query(api.queries.getStrategyOwnedInstruments, { ...requireMachineAuth(), strategyId }));
        },
        async getAllOwnedInstrumentsByApp(app) {
            return await runWithTimeout("Convex query getAllOwnedInstrumentsByApp", async () => await client.query(api.queries.getAllOwnedInstrumentsByApp, { ...requireMachineAuth(), app }));
        },
        async getLatestPositions(strategyId) {
            const docs = await runWithTimeout("Convex query getStrategyPositions", async () => await client.query(api.queries.getStrategyPositions, {
                ...requireMachineAuth(),
                strategyId,
            }));
            return docs.map((doc) => ({
                instrument: doc.instrument,
                side: doc.side,
                quantity: doc.quantity,
                entryPrice: doc.entryPrice,
                currentPrice: doc.currentPrice,
                unrealizedPnl: doc.unrealizedPnl,
                metadata: doc.metadata ? JSON.parse(doc.metadata) : undefined,
            }));
        },
        async getAllStrategies() {
            return await runWithTimeout("Convex query getAllStrategies", async () => await client.query(api.queries.getAllStrategies, { ...requireMachineAuth() }));
        },
        async addStrategy(config) {
            return await runWithTimeout("Convex mutation upsertStrategy", async () => await client.mutation(api.mutations.upsertStrategy, {
                ...requireMachineAuth(),
                app: config.app,
                name: config.name,
                enabled: config.enabled,
                schedule: config.schedule,
                policy: config.policy,
                context: config.context,
            }));
        },
        async disableStrategy(id) {
            await runWithTimeout("Convex mutation disableStrategy", async () => await client.mutation(api.mutations.disableStrategy, {
                ...requireMachineAuth(),
                strategyId: id,
            }));
        },
        async deleteStrategy(id) {
            return await runWithTimeout("Convex mutation deleteStrategy", async () => await client.mutation(api.mutations.deleteStrategy, {
                ...requireMachineAuth(),
                strategyId: id,
            }));
        },
        async deleteAllStrategies() {
            return await runWithTimeout("Convex mutation deleteAllStrategies", async () => await client.mutation(api.mutations.deleteAllStrategies, {
                ...requireMachineAuth(),
            }));
        },
        async replaceAllStrategies(strategies) {
            return await runWithTimeout("Convex mutation replaceAllStrategies", async () => await client.mutation(api.mutations.replaceAllStrategies, {
                ...requireMachineAuth(),
                strategies,
            }));
        },
    };
};
export const createConvexOrderPersistenceAdapter = (config) => {
    const client = new ConvexHttpClient(config.url);
    const timeoutMs = config.timeoutMs ?? 30_000;
    const requireAdapterAuth = () => {
        const serviceToken = config.machineAuth?.serviceToken?.trim();
        if (!serviceToken) {
            throw new Error("Order persistence adapter requires a backend service token");
        }
        return { serviceToken };
    };
    const runWithTimeout = async (name, operation) => {
        return await withTimeout(operation, timeoutMs, name);
    };
    return {
        async upsertOrder(snapshot) {
            await runWithTimeout("Convex mutation upsertOrder", async () => await client.mutation(api.mutations.upsertOrder, {
                ...requireAdapterAuth(),
                orderId: snapshot.orderId,
                runId: snapshot.runId,
                strategyId: snapshot.strategyId,
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
            }));
        },
        async logOrderTransition(transition) {
            await runWithTimeout("Convex mutation logOrderTransition", async () => await client.mutation(api.mutations.logOrderTransition, {
                ...requireAdapterAuth(),
                orderId: transition.orderId,
                runId: transition.runId,
                strategyId: transition.strategyId,
                sequence: transition.sequence,
                type: transition.type,
                status: transition.status,
                previousStatus: transition.previousStatus,
                reason: transition.reason,
                details: transition.details,
                timestamp: transition.timestamp,
            }));
        },
        async getOrder(orderId) {
            const order = await runWithTimeout("Convex query getOrderById", async () => await client.query(api.queries.getOrderById, { ...requireAdapterAuth(), orderId }));
            return order;
        },
        async listActiveOrders(strategyId) {
            const orders = await runWithTimeout("Convex query getActiveOrders", async () => await client.query(api.queries.getActiveOrders, {
                ...requireAdapterAuth(),
                strategyId: strategyId,
            }));
            return orders;
        },
        async createAlert(alert) {
            await runWithTimeout("Convex mutation createAlert(orderLifecycle)", async () => await client.mutation(api.mutations.createAlert, {
                ...requireAdapterAuth(),
                strategyId: alert.strategyId,
                severity: alert.severity,
                message: alert.message,
            }));
        },
    };
};
