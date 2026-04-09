import { BASE_RISK_VALIDATORS, validateIntent } from "./risk";
import { filterPositionsByOwnership } from "./position-filter";
import { getIntentAction, hasIntentChanges, createSyntheticIntent } from "./intent";
import { OrderLifecycleManager } from "./order-tracker";
import { createExecutionErrorDetail, formatExecutionError, getErrorMessage, getExecutionErrorDetail, } from "./utils";
export const PRICE_VERIFICATION_STATUSES = ["pass", "warn", "block", "skipped"];
const ALLOWED_VALIDATION = { allowed: true };
const DEFAULT_PRICE_VERIFICATION_CONFIG = {
    warningThresholdPercent: 10,
    blockingThresholdPercent: 20,
};
export class ExecutionPipeline {
    venue;
    venueName;
    policy;
    riskValidators;
    priceVerificationConfig;
    logger;
    tradeEventLogger;
    lifecycleManager;
    runId;
    strategyId;
    ownedInstruments;
    dryRun;
    dryRunPositionBook;
    constructor(config) {
        this.venue = config.venue;
        this.venueName = config.venueName;
        this.policy = config.policy;
        this.riskValidators = config.riskValidators ?? BASE_RISK_VALIDATORS;
        this.priceVerificationConfig = resolvePriceVerificationConfig(config.priceVerification);
        this.logger = config.logger;
        this.tradeEventLogger = config.tradeEventLogger;
        this.runId = config.runId;
        this.strategyId = config.strategyId;
        this.ownedInstruments = config.ownedInstruments ?? null;
        this.dryRun = Boolean(config.policy.dryRun);
        this.dryRunPositionBook = new Map();
        this.lifecycleManager = new OrderLifecycleManager(config.venue, config.logger, config.lifecycle, config.orderPersistence, config.tradeEventLogger, config.runId, config.strategyId, config.venueName, (previousSnapshot, currentSnapshot) => {
            this.reconcileOwnedInstrumentsFromSnapshot(previousSnapshot, currentSnapshot);
        });
    }
    async executeIntent(intent, accountState, positions, lifecycleContext = { action: getIntentAction(intent) }) {
        const intentWithLifecycleMetadata = withLifecycleAction(intent, lifecycleContext);
        this.logger.info("Order intent received", { intent: intentWithLifecycleMetadata, action: lifecycleContext.action });
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intentWithLifecycleMetadata);
        const validation = validateIntent(intentWithLifecycleMetadata, this.policy, accountState, positions, this.riskValidators);
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intentWithLifecycleMetadata);
        if (!validation.allowed) {
            this.logger.warn("Order rejected by risk engine", { reason: validation.reason, intent: intentWithLifecycleMetadata });
            const errorDetail = createExecutionErrorDetail("risk_engine", validation.reason ?? "Order rejected by risk engine");
            const rejectedResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
            return { result: rejectedResult, validation };
        }
        const finalIntent = validation.adjustedIntent ?? intentWithLifecycleMetadata;
        const priceVerification = await this.runPriceVerification(finalIntent);
        if (priceVerification?.status === "block") {
            this.logger.warn("Order blocked by price verification", {
                venue: this.venueName,
                intent: finalIntent,
                priceVerification,
            });
            const errorDetail = createExecutionErrorDetail("pre_validation", priceVerification.message, {
                code: "PRICE_VERIFICATION_BLOCKED",
                retryable: false,
                details: {
                    priceVerification,
                },
            });
            const rejectedResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
                priceVerification,
            };
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, rejectedResult, finalIntent);
            return { result: rejectedResult, validation };
        }
        if (this.policy.dryRun) {
            this.logger.info("Dry run -- order simulated", { intent: finalIntent });
            const mockResult = {
                orderId: `dry-run-${Date.now()}`,
                status: "filled",
                filledQuantity: finalIntent.quantity,
                fillPrice: finalIntent.limitPrice ?? finalIntent.metadata?.estimatedPrice ?? 0,
                timestamp: Date.now(),
                priceVerification,
            };
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, mockResult, finalIntent);
            const handle = await this.lifecycleManager.registerSubmittedOrder(finalIntent, mockResult, lifecycleContext.action, lifecycleContext.metadata);
            this.updateOwnedInstruments(lifecycleContext.action, finalIntent.instrument, mockResult);
            this.netDryRunPosition(finalIntent.instrument, finalIntent.side, finalIntent.quantity, mockResult.fillPrice ?? 0, lifecycleContext.action);
            return { result: mockResult, validation, handle };
        }
        try {
            const result = await this.venue.submitOrder(finalIntent);
            const resultWithVerification = {
                ...result,
                priceVerification,
            };
            this.logger.info("Order submitted", {
                orderId: resultWithVerification.orderId,
                status: resultWithVerification.status,
                priceVerification,
            });
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, resultWithVerification, finalIntent);
            const handle = await this.lifecycleManager.registerSubmittedOrder(finalIntent, resultWithVerification, lifecycleContext.action, lifecycleContext.metadata);
            this.updateOwnedInstruments(lifecycleContext.action, finalIntent.instrument, resultWithVerification);
            return { result: resultWithVerification, validation, handle };
        }
        catch (error) {
            const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error));
            const errorMsg = formatExecutionError(errorDetail);
            this.logger.error("Order submission failed", { error: errorMsg, intent: finalIntent });
            const failedResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: errorMsg,
                errorDetail,
                priceVerification,
            };
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, failedResult, finalIntent);
            return { result: failedResult, validation };
        }
    }
    async cancelOrder(orderId, reason) {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId);
        const instrument = existing?.instrument ?? "order-cancel";
        const intent = createSyntheticIntent("cancel", instrument, "sell", 0, orderId, { reason });
        this.logger.info("Cancelling order", { orderId, reason });
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent);
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent);
        if (this.policy.dryRun) {
            const result = {
                orderId,
                status: "cancelled",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
            };
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent);
            await this.lifecycleManager.recordCancelAttempt(orderId, reason);
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "cancel_attempt", reason);
            return result;
        }
        await this.lifecycleManager.recordCancelAttempt(orderId, reason);
        let result;
        try {
            result = await this.venue.cancelOrder(orderId);
        }
        catch (error) {
            result = createRejectedExecutionResultFromUnknownError(orderId, error);
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent);
        await this.lifecycleManager.captureVenueUpdate(orderId, result, "cancel_attempt", reason);
        return result;
    }
    async modifyOrder(orderId, changes, reason) {
        const hasChanges = hasIntentChanges(changes);
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId);
        const instrument = existing?.instrument ?? "order-modify";
        const side = existing?.intent.side ?? "buy";
        const intent = {
            instrument,
            side,
            quantity: changes.quantity ?? existing?.quantity ?? 0,
            orderType: changes.orderType ?? existing?.intent.orderType ?? "limit",
            limitPrice: changes.limitPrice,
            stopPrice: changes.stopPrice,
            timeInForce: changes.timeInForce ?? existing?.intent.timeInForce ?? "day",
            legs: changes.legs,
            metadata: {
                action: "modify",
                orderId,
                reason,
            },
        };
        this.logger.info("Modifying order", { orderId, changes, reason });
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent);
        if (!hasChanges) {
            const validation = {
                allowed: false,
                reason: "At least one order modification must be provided",
            };
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent);
            const errorDetail = createExecutionErrorDetail("pre_validation", validation.reason ?? "At least one order modification must be provided");
            return {
                orderId,
                status: "rejected",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
        }
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent);
        await this.lifecycleManager.recordModifyAttempt(orderId, changes, reason);
        if (this.policy.dryRun) {
            const result = {
                orderId,
                status: existing?.status ?? "pending",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                intentUpdates: changes,
            };
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent);
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "modify_attempt", reason);
            return result;
        }
        let result;
        try {
            result = await this.venue.modifyOrder(orderId, changes);
        }
        catch (error) {
            result = createRejectedExecutionResultFromUnknownError(orderId, error, existing?.filledQuantity ?? 0, existing?.avgFillPrice);
        }
        const normalizedResult = normalizeModifyExecutionResult(result, existing, orderId);
        const resultWithIntentUpdates = {
            ...normalizedResult,
            intentUpdates: shouldPersistModifyIntentUpdates(result)
                ? mergeExecutionIntentUpdates(changes, result.intentUpdates)
                : undefined,
        };
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, resultWithIntentUpdates, intent);
        await this.lifecycleManager.captureVenueUpdate(orderId, resultWithIntentUpdates, "modify_attempt", reason);
        return resultWithIntentUpdates;
    }
    async closePosition(instrument, reason, options = {}) {
        const positions = await this.getPositions();
        const position = positions.find((item) => item.instrument === instrument);
        const closeSide = position?.side === "long" ? "sell" : "buy";
        let intent = {
            instrument,
            side: closeSide,
            quantity: position?.quantity ?? 0,
            orderType: "market",
            timeInForce: "day",
            metadata: {
                action: "close",
                reason,
                estimatedPrice: options.estimatedPrice,
            },
        };
        if (position && this.venue.buildCloseIntent) {
            let venueIntent;
            try {
                venueIntent = await this.venue.buildCloseIntent(instrument);
            }
            catch (error) {
                const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error));
                return {
                    result: {
                        orderId: "",
                        status: "rejected",
                        filledQuantity: 0,
                        timestamp: Date.now(),
                        error: formatExecutionError(errorDetail),
                        errorDetail,
                    },
                    validation: {
                        allowed: false,
                        reason: errorDetail.message,
                    },
                };
            }
            intent = {
                ...venueIntent,
                metadata: {
                    ...venueIntent.metadata,
                    action: "close",
                    reason,
                    estimatedPrice: options.estimatedPrice ?? venueIntent.metadata?.estimatedPrice,
                },
            };
        }
        this.logger.info("Closing position", { instrument, reason });
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent);
        if (!position) {
            const validation = {
                allowed: false,
                reason: `No open position found for ${instrument}`,
            };
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent);
            const errorDetail = createExecutionErrorDetail("pre_validation", validation.reason ?? "No open position found");
            return {
                result: {
                    orderId: "",
                    status: "rejected",
                    filledQuantity: 0,
                    timestamp: Date.now(),
                    error: formatExecutionError(errorDetail),
                    errorDetail,
                },
                validation,
            };
        }
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent);
        if (this.policy.dryRun) {
            const result = {
                orderId: `dry-run-close-${Date.now()}`,
                status: "filled",
                filledQuantity: position.quantity,
                fillPrice: intent.metadata?.estimatedPrice ??
                    position.currentPrice ??
                    position.entryPrice,
                timestamp: Date.now(),
            };
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent);
            const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason });
            this.updateOwnedInstruments("close", instrument, result);
            this.dryRunPositionBook.delete(instrument);
            return { result, validation: ALLOWED_VALIDATION, handle };
        }
        let result;
        try {
            result = await this.venue.closePosition(instrument, intent);
        }
        catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error);
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent);
        const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason });
        this.updateOwnedInstruments("close", instrument, result);
        return { result, validation: ALLOWED_VALIDATION, handle };
    }
    async getOrderStatus(orderId) {
        const result = await this.venue.getOrderStatus(orderId);
        await this.lifecycleManager.captureVenueUpdate(orderId, result, "status_change");
        return result;
    }
    async waitForOrderUpdate(orderId, onUpdate, options = {}) {
        return this.lifecycleManager.waitForUpdate(orderId, onUpdate, options);
    }
    async getOrderSnapshot(orderId) {
        return this.lifecycleManager.getOrderSnapshot(orderId);
    }
    async resumeOpenOrders(onUpdate) {
        return this.lifecycleManager.resumeActiveOrders(onUpdate);
    }
    getTrackedOrder(orderId) {
        return this.lifecycleManager.getTrackedSnapshot(orderId);
    }
    getTrackedOrders() {
        return this.lifecycleManager.getTrackedOrders();
    }
    stopTracking(orderId) {
        this.lifecycleManager.stopTracking(orderId);
    }
    stopAllTracking() {
        this.lifecycleManager.stopAll();
    }
    async getPositions() {
        if (this.dryRun) {
            return Array.from(this.dryRunPositionBook.values());
        }
        const positions = await this.venue.getPositions();
        if (this.ownedInstruments) {
            return filterPositionsByOwnership(positions, this.ownedInstruments);
        }
        return positions;
    }
    seedDryRunPositions(positions) {
        this.dryRunPositionBook.clear();
        for (const position of positions) {
            this.dryRunPositionBook.set(position.instrument, position);
        }
    }
    getDryRunPositions() {
        return Array.from(this.dryRunPositionBook.values());
    }
    async getAccountState() {
        return this.venue.getAccountState();
    }
    async runPriceVerification(intent) {
        if (!hasPriceVerifier(this.venue)) {
            return undefined;
        }
        try {
            const verification = finalizePriceVerification(await this.venue.verify(intent), this.priceVerificationConfig);
            this.logPriceVerification(intent, verification);
            return verification;
        }
        catch (error) {
            const message = getErrorMessage(error);
            const verification = finalizePriceVerification({
                ok: true,
                status: "warn",
                livePrices: {},
                proposedPrice: resolveIntentProposedPrice(intent),
                message: `Price verification unavailable: ${message}. Submitted without broker snapshot.`,
                details: {
                    venue: this.venueName,
                    verificationError: message,
                },
            }, this.priceVerificationConfig);
            this.logger.warn("Price verification failed", {
                venue: this.venueName,
                intent,
                error: message,
            });
            return verification;
        }
    }
    logPriceVerification(intent, verification) {
        if (verification.status === "block") {
            this.logger.warn("Price verification blocked submission", {
                venue: this.venueName,
                intent,
                priceVerification: verification,
            });
            return;
        }
        if (verification.status === "warn") {
            this.logger.warn("Price verification warning", {
                venue: this.venueName,
                intent,
                priceVerification: verification,
            });
            return;
        }
        if (verification.status === "skipped") {
            this.logger.info("Price verification skipped", {
                venue: this.venueName,
                intent,
                priceVerification: verification,
            });
            return;
        }
        this.logger.info("Price verification passed", {
            venue: this.venueName,
            intent,
            priceVerification: verification,
        });
    }
    netDryRunPosition(instrument, side, quantity, fillPrice, action) {
        if (action === "close") {
            this.dryRunPositionBook.delete(instrument);
            return;
        }
        if (action !== "entry" && action !== "adjustment") {
            return;
        }
        const positionSide = side === "buy" ? "long" : "short";
        const existing = this.dryRunPositionBook.get(instrument);
        if (!existing) {
            this.dryRunPositionBook.set(instrument, {
                instrument,
                side: positionSide,
                quantity,
                entryPrice: fillPrice,
            });
            return;
        }
        if (existing.side === positionSide) {
            const totalQty = existing.quantity + quantity;
            const avgEntry = (existing.quantity * existing.entryPrice + quantity * fillPrice) / totalQty;
            this.dryRunPositionBook.set(instrument, {
                ...existing,
                quantity: totalQty,
                entryPrice: avgEntry,
            });
        }
        else {
            const netQty = existing.quantity - quantity;
            if (netQty <= 0) {
                this.dryRunPositionBook.delete(instrument);
            }
            else {
                this.dryRunPositionBook.set(instrument, {
                    ...existing,
                    quantity: netQty,
                });
            }
        }
    }
    updateOwnedInstruments(action, instrument, result) {
        if (!this.ownedInstruments) {
            return;
        }
        if (action === "entry" || action === "adjustment") {
            if (result.status === "pending" ||
                result.status === "partially_filled" ||
                result.status === "filled") {
                this.ownedInstruments.add(instrument);
            }
        }
    }
    reconcileOwnedInstrumentsFromSnapshot(previousSnapshot, currentSnapshot) {
        if (!this.ownedInstruments) {
            return;
        }
        if (currentSnapshot.action === "entry" || currentSnapshot.action === "adjustment") {
            const isActive = currentSnapshot.status === "pending" ||
                currentSnapshot.status === "partially_filled" ||
                currentSnapshot.status === "filled";
            if (isActive) {
                this.ownedInstruments.add(currentSnapshot.instrument);
                return;
            }
            const wasActive = previousSnapshot.status === "pending" ||
                previousSnapshot.status === "partially_filled" ||
                previousSnapshot.status === "filled";
            if (wasActive) {
                this.ownedInstruments.delete(currentSnapshot.instrument);
            }
        }
    }
}
function createRejectedExecutionResultFromUnknownError(orderId, error, filledQuantity = 0, fillPrice) {
    const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error));
    return {
        orderId,
        status: "rejected",
        filledQuantity,
        fillPrice,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    };
}
function withLifecycleAction(intent, lifecycleContext) {
    if (!lifecycleContext.action || intent.metadata?.action) {
        return intent;
    }
    return {
        ...intent,
        metadata: {
            ...intent.metadata,
            action: lifecycleContext.action,
            ...lifecycleContext.metadata,
        },
    };
}
function mergeExecutionIntentUpdates(requestedChanges, venueUpdates) {
    return {
        ...requestedChanges,
        ...venueUpdates,
        metadata: requestedChanges.metadata || venueUpdates?.metadata
            ? {
                ...requestedChanges.metadata,
                ...venueUpdates?.metadata,
            }
            : undefined,
    };
}
function shouldPersistModifyIntentUpdates(result) {
    return (result.status === "pending" ||
        result.status === "partially_filled" ||
        result.status === "filled");
}
function normalizeModifyExecutionResult(result, existing, orderId) {
    if (!existing) {
        return {
            ...result,
            orderId: result.orderId || orderId,
        };
    }
    const preserveFilledState = existing.status === "filled" &&
        result.status === "filled" &&
        result.filledQuantity === 0 &&
        result.fillPrice === undefined;
    return {
        ...result,
        orderId: result.orderId || orderId,
        status: preserveFilledState ? existing.status : result.status,
        filledQuantity: preserveFilledState
            ? existing.filledQuantity
            : result.filledQuantity,
        fillPrice: preserveFilledState
            ? existing.avgFillPrice
            : result.fillPrice ?? existing.avgFillPrice,
    };
}
function resolvePriceVerificationConfig(config) {
    const warningThresholdPercent = config?.warningThresholdPercent ?? DEFAULT_PRICE_VERIFICATION_CONFIG.warningThresholdPercent;
    const blockingThresholdPercent = config?.blockingThresholdPercent ?? DEFAULT_PRICE_VERIFICATION_CONFIG.blockingThresholdPercent;
    return {
        warningThresholdPercent,
        blockingThresholdPercent: Math.max(blockingThresholdPercent, warningThresholdPercent),
    };
}
function hasPriceVerifier(venue) {
    return typeof venue.verify === "function";
}
function finalizePriceVerification(verification, config) {
    const driftPercent = typeof verification.driftPercent === "number"
        ? Math.abs(verification.driftPercent)
        : undefined;
    let status = verification.status ?? "pass";
    let ok = verification.ok;
    if (!ok || status === "block") {
        status = "block";
        ok = false;
    }
    else if (driftPercent !== undefined && driftPercent > config.blockingThresholdPercent) {
        status = "block";
        ok = false;
    }
    else if (status !== "warn" &&
        driftPercent !== undefined &&
        driftPercent > config.warningThresholdPercent) {
        status = "warn";
        ok = true;
    }
    return {
        ...verification,
        ok,
        status,
        driftPercent,
        warningThresholdPercent: config.warningThresholdPercent,
        blockingThresholdPercent: config.blockingThresholdPercent,
        message: buildPriceVerificationMessage(verification, driftPercent, status, config),
    };
}
function buildPriceVerificationMessage(verification, driftPercent, status, config) {
    if (driftPercent === undefined) {
        return verification.message;
    }
    const proposedPrice = verification.proposedPrice;
    const liveMid = verification.livePrices.mid;
    const drift = verification.drift;
    if (verification.status === "block" || verification.ok === false) {
        return verification.message;
    }
    const liveText = liveMid !== undefined ? `live mid ${liveMid}` : "live midpoint unavailable";
    const proposedText = proposedPrice !== undefined ? `proposed price ${proposedPrice}` : "no proposed price";
    const driftText = drift !== undefined ? `drift ${drift}` : "drift unavailable";
    if (status === "block") {
        return `Blocked by price verification: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}% exceeds ${config.blockingThresholdPercent}%`;
    }
    if (status === "warn") {
        return `Price verification warning: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}% exceeds ${config.warningThresholdPercent}%`;
    }
    return `Price verification passed: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}%`;
}
function resolveIntentProposedPrice(intent) {
    if (typeof intent.limitPrice === "number") {
        return intent.limitPrice;
    }
    if (typeof intent.stopPrice === "number") {
        return intent.stopPrice;
    }
    const estimatedPrice = intent.metadata?.estimatedPrice;
    return typeof estimatedPrice === "number" ? estimatedPrice : undefined;
}
