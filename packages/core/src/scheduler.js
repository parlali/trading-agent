function parseCronField(field, min, max) {
    const values = new Set();
    for (const part of field.split(",")) {
        if (part === "*") {
            for (let i = min; i <= max; i++)
                values.add(i);
        }
        else if (part.includes("/")) {
            const [range, stepStr] = part.split("/");
            const step = parseInt(stepStr, 10);
            let start = min;
            let end = max;
            if (range !== "*" && range.includes("-")) {
                const [s, e] = range.split("-");
                start = parseInt(s, 10);
                end = parseInt(e, 10);
            }
            else if (range !== "*") {
                start = parseInt(range, 10);
            }
            for (let i = start; i <= end; i += step)
                values.add(i);
        }
        else if (part.includes("-")) {
            const [s, e] = part.split("-");
            for (let i = parseInt(s, 10); i <= parseInt(e, 10); i++)
                values.add(i);
        }
        else {
            values.add(parseInt(part, 10));
        }
    }
    return values;
}
export function cronMatchesDate(expression, date) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
    }
    const [minuteField, hourField, domField, monthField, dowField] = fields;
    const minutes = parseCronField(minuteField, 0, 59);
    const hours = parseCronField(hourField, 0, 23);
    const daysOfMonth = parseCronField(domField, 1, 31);
    const months = parseCronField(monthField, 1, 12);
    const daysOfWeek = parseCronField(dowField, 0, 6);
    return (minutes.has(date.getMinutes()) &&
        hours.has(date.getHours()) &&
        daysOfMonth.has(date.getDate()) &&
        months.has(date.getMonth() + 1) &&
        daysOfWeek.has(date.getDay()));
}
export function getNextCronFireMs(expression, from = new Date()) {
    const base = new Date(from);
    base.setSeconds(0, 0);
    const maxMinutes = 24 * 60 * 7;
    for (let i = 1; i <= maxMinutes; i++) {
        const candidate = new Date(base.getTime() + i * 60_000);
        if (cronMatchesDate(expression, candidate)) {
            return i * 60_000;
        }
    }
    return null;
}
export const DEFAULT_STALE_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_ONESHOT_GAP_MS = 5 * 60 * 1000;
export class Scheduler {
    strategies = new Map();
    cronTicker = null;
    tickInterval;
    staleRunTimeoutMs;
    logger;
    shuttingDown = false;
    inFlightRuns = new Map();
    constructor(config) {
        this.tickInterval = config.tickInterval ?? 10_000;
        this.staleRunTimeoutMs = config.staleRunTimeoutMs ?? DEFAULT_STALE_RUN_TIMEOUT_MS;
        this.logger = config.logger;
    }
    register(config) {
        if (this.strategies.has(config.strategyId)) {
            this.unregister(config.strategyId);
        }
        const tracked = {
            config,
            running: false,
        };
        if (config.scheduleType === "interval" && config.intervalMs) {
            tracked.timer = setInterval(() => {
                this.triggerStrategy(config.strategyId);
            }, config.intervalMs);
        }
        this.strategies.set(config.strategyId, tracked);
        this.logger.info("Strategy registered", {
            strategyId: config.strategyId,
            scheduleType: config.scheduleType,
            cron: config.cronExpression,
            interval: config.intervalMs,
        });
    }
    unregister(strategyId) {
        const tracked = this.strategies.get(strategyId);
        if (tracked?.timer) {
            clearInterval(tracked.timer);
        }
        this.strategies.delete(strategyId);
        this.logger.info("Strategy unregistered", { strategyId });
    }
    start() {
        if (this.cronTicker)
            return;
        this.logger.info("Scheduler starting", { strategies: this.strategies.size, tickInterval: this.tickInterval });
        this.tick();
        this.cronTicker = setInterval(() => {
            this.tick();
        }, this.tickInterval);
    }
    async triggerManual(strategyId) {
        return this.triggerStrategy(strategyId);
    }
    async shutdown() {
        this.shuttingDown = true;
        this.logger.info("Scheduler shutting down", { inFlightRuns: this.inFlightRuns.size });
        if (this.cronTicker) {
            clearInterval(this.cronTicker);
            this.cronTicker = null;
        }
        for (const [, tracked] of this.strategies) {
            if (tracked.timer) {
                clearInterval(tracked.timer);
                tracked.timer = undefined;
            }
        }
        if (this.inFlightRuns.size > 0) {
            this.logger.info("Waiting for in-flight runs to complete", {
                strategies: Array.from(this.inFlightRuns.keys()),
            });
            await Promise.allSettled(Array.from(this.inFlightRuns.values()));
        }
        this.strategies.clear();
        this.logger.info("Scheduler shutdown complete");
    }
    getRegisteredStrategies() {
        return Array.from(this.strategies.keys());
    }
    isRunning(strategyId) {
        return this.strategies.get(strategyId)?.running ?? false;
    }
    scheduleOneshot(parentStrategyId, delayMs, handler) {
        const callbackId = `${parentStrategyId}:callback:${Date.now()}`;
        const staleCallbacks = Array.from(this.strategies.keys()).filter((id) => id.startsWith(`${parentStrategyId}:callback:`));
        for (const id of staleCallbacks) {
            this.unregister(id);
        }
        const guardedHandler = async () => {
            const parent = this.strategies.get(parentStrategyId);
            if (parent?.running) {
                this.logger.info("Oneshot skipped -- parent strategy already running", {
                    callbackId,
                    parentStrategyId,
                });
                return;
            }
            if (parent?.lastOneshotAt) {
                const gap = Date.now() - parent.lastOneshotAt;
                if (gap < MIN_ONESHOT_GAP_MS) {
                    this.logger.warn("Oneshot suppressed -- too soon after last oneshot run", {
                        callbackId,
                        parentStrategyId,
                        gapMs: gap,
                        minGapMs: MIN_ONESHOT_GAP_MS,
                    });
                    return;
                }
            }
            if (parent) {
                parent.running = true;
                parent.lastRun = Date.now();
                parent.lastOneshotAt = Date.now();
            }
            try {
                await handler();
            }
            finally {
                if (parent) {
                    parent.running = false;
                }
            }
        };
        this.register({
            strategyId: callbackId,
            scheduleType: "oneshot",
            handler: guardedHandler,
        });
        const tracked = this.strategies.get(callbackId);
        if (tracked) {
            tracked.timer = setTimeout(() => {
                this.triggerStrategy(callbackId);
            }, delayMs);
        }
        this.logger.info("Oneshot scheduled", {
            callbackId,
            parentStrategyId,
            delayMs,
        });
    }
    tick() {
        if (this.shuttingDown)
            return;
        const now = new Date();
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
        for (const [strategyId, tracked] of this.strategies) {
            if (tracked.config.scheduleType !== "cron")
                continue;
            if (!tracked.config.cronExpression)
                continue;
            try {
                if (cronMatchesDate(tracked.config.cronExpression, now)) {
                    if (tracked.lastCronMinute === minuteKey)
                        continue;
                    tracked.lastCronMinute = minuteKey;
                    this.triggerStrategy(strategyId);
                }
            }
            catch (error) {
                this.logger.error("Cron match error", {
                    strategyId,
                    cron: tracked.config.cronExpression,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    async triggerStrategy(strategyId) {
        if (this.shuttingDown)
            return;
        const tracked = this.strategies.get(strategyId);
        if (!tracked) {
            this.logger.warn("Trigger for unknown strategy", { strategyId });
            return;
        }
        if (tracked.running) {
            const elapsed = tracked.lastRun ? Date.now() - tracked.lastRun : 0;
            if (elapsed > this.staleRunTimeoutMs) {
                this.logger.error("Force-unlocking stale strategy run", {
                    strategyId,
                    elapsedMs: elapsed,
                    timeoutMs: this.staleRunTimeoutMs,
                });
                tracked.running = false;
                this.inFlightRuns.delete(strategyId);
            }
            else {
                this.logger.warn("Skipping -- strategy already running", {
                    strategyId,
                    elapsedMs: elapsed,
                });
                return;
            }
        }
        tracked.running = true;
        tracked.lastRun = Date.now();
        this.logger.info("Triggering strategy run", { strategyId });
        const runPromise = (async () => {
            try {
                await tracked.config.handler();
                this.logger.info("Strategy run completed", { strategyId });
            }
            catch (error) {
                this.logger.error("Strategy run failed", {
                    strategyId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            finally {
                tracked.running = false;
                this.inFlightRuns.delete(strategyId);
                if (tracked.config.scheduleType === "oneshot") {
                    this.unregister(strategyId);
                }
            }
        })();
        this.inFlightRuns.set(strategyId, runPromise);
        return runPromise;
    }
}
