import type { Logger } from "./logger"

function parseCronField(field: string, min: number, max: number): Set<number> {
    const values = new Set<number>()

    for (const part of field.split(",")) {
        if (part === "*") {
            for (let i = min; i <= max; i++) values.add(i)
        } else if (part.includes("/")) {
            const [range, stepStr] = part.split("/")
            const step = parseInt(stepStr!, 10)
            let start = min
            let end = max
            if (range !== "*" && range!.includes("-")) {
                const [s, e] = range!.split("-")
                start = parseInt(s!, 10)
                end = parseInt(e!, 10)
            } else if (range !== "*") {
                start = parseInt(range!, 10)
            }
            for (let i = start; i <= end; i += step) values.add(i)
        } else if (part.includes("-")) {
            const [s, e] = part.split("-")
            for (let i = parseInt(s!, 10); i <= parseInt(e!, 10); i++) values.add(i)
        } else {
            values.add(parseInt(part, 10))
        }
    }

    return values
}

export function cronMatchesDate(expression: string, date: Date): boolean {
    const fields = expression.trim().split(/\s+/)
    if (fields.length !== 5) {
        throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`)
    }

    const [minuteField, hourField, domField, monthField, dowField] = fields as [string, string, string, string, string]

    const minutes = parseCronField(minuteField, 0, 59)
    const hours = parseCronField(hourField, 0, 23)
    const daysOfMonth = parseCronField(domField, 1, 31)
    const months = parseCronField(monthField, 1, 12)
    const daysOfWeek = parseCronField(dowField, 0, 6)

    return (
        minutes.has(date.getMinutes()) &&
        hours.has(date.getHours()) &&
        daysOfMonth.has(date.getDate()) &&
        months.has(date.getMonth() + 1) &&
        daysOfWeek.has(date.getDay())
    )
}

export type ScheduleType = "cron" | "interval" | "oneshot"

export interface ScheduledStrategy {
    strategyId: string
    scheduleType: ScheduleType
    cronExpression?: string
    intervalMs?: number
    handler: () => Promise<void>
}

interface TrackedStrategy {
    config: ScheduledStrategy
    running: boolean
    lastRun?: number
    timer?: ReturnType<typeof setInterval>
}

export interface SchedulerConfig {
    tickInterval?: number
    logger: Logger
}

export class Scheduler {
    private strategies = new Map<string, TrackedStrategy>()
    private cronTicker: ReturnType<typeof setInterval> | null = null
    private tickInterval: number
    private logger: Logger
    private shuttingDown = false
    private inFlightRuns = new Map<string, Promise<void>>()

    constructor(config: SchedulerConfig) {
        this.tickInterval = config.tickInterval ?? 60_000
        this.logger = config.logger
    }

    register(config: ScheduledStrategy): void {
        if (this.strategies.has(config.strategyId)) {
            this.unregister(config.strategyId)
        }

        const tracked: TrackedStrategy = {
            config,
            running: false,
        }

        if (config.scheduleType === "interval" && config.intervalMs) {
            tracked.timer = setInterval(() => {
                this.triggerStrategy(config.strategyId)
            }, config.intervalMs)
        }

        this.strategies.set(config.strategyId, tracked)
        this.logger.info("Strategy registered", {
            strategyId: config.strategyId,
            scheduleType: config.scheduleType,
            cron: config.cronExpression,
            interval: config.intervalMs,
        })
    }

    unregister(strategyId: string): void {
        const tracked = this.strategies.get(strategyId)
        if (tracked?.timer) {
            clearInterval(tracked.timer)
        }
        this.strategies.delete(strategyId)
        this.logger.info("Strategy unregistered", { strategyId })
    }

    start(): void {
        if (this.cronTicker) return

        this.logger.info("Scheduler starting", { strategies: this.strategies.size, tickInterval: this.tickInterval })

        this.tick()

        this.cronTicker = setInterval(() => {
            this.tick()
        }, this.tickInterval)
    }

    async triggerManual(strategyId: string): Promise<void> {
        return this.triggerStrategy(strategyId)
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true
        this.logger.info("Scheduler shutting down", { inFlightRuns: this.inFlightRuns.size })

        if (this.cronTicker) {
            clearInterval(this.cronTicker)
            this.cronTicker = null
        }

        for (const [, tracked] of this.strategies) {
            if (tracked.timer) {
                clearInterval(tracked.timer)
                tracked.timer = undefined
            }
        }

        if (this.inFlightRuns.size > 0) {
            this.logger.info("Waiting for in-flight runs to complete", {
                strategies: Array.from(this.inFlightRuns.keys()),
            })
            await Promise.allSettled(Array.from(this.inFlightRuns.values()))
        }

        this.strategies.clear()
        this.logger.info("Scheduler shutdown complete")
    }

    getRegisteredStrategies(): string[] {
        return Array.from(this.strategies.keys())
    }

    isRunning(strategyId: string): boolean {
        return this.strategies.get(strategyId)?.running ?? false
    }

    private tick(): void {
        if (this.shuttingDown) return

        const now = new Date()

        for (const [strategyId, tracked] of this.strategies) {
            if (tracked.config.scheduleType !== "cron") continue
            if (!tracked.config.cronExpression) continue

            try {
                if (cronMatchesDate(tracked.config.cronExpression, now)) {
                    this.triggerStrategy(strategyId)
                }
            } catch (error) {
                this.logger.error("Cron match error", {
                    strategyId,
                    cron: tracked.config.cronExpression,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }
    }

    private async triggerStrategy(strategyId: string): Promise<void> {
        if (this.shuttingDown) return

        const tracked = this.strategies.get(strategyId)
        if (!tracked) {
            this.logger.warn("Trigger for unknown strategy", { strategyId })
            return
        }

        if (tracked.running) {
            this.logger.info("Skipping -- strategy already running", { strategyId })
            return
        }

        tracked.running = true
        tracked.lastRun = Date.now()
        this.logger.info("Triggering strategy run", { strategyId })

        const runPromise = (async () => {
            try {
                await tracked.config.handler()
                this.logger.info("Strategy run completed", { strategyId })
            } catch (error) {
                this.logger.error("Strategy run failed", {
                    strategyId,
                    error: error instanceof Error ? error.message : String(error),
                })
            } finally {
                tracked.running = false
                this.inFlightRuns.delete(strategyId)

                if (tracked.config.scheduleType === "oneshot") {
                    this.unregister(strategyId)
                }
            }
        })()

        this.inFlightRuns.set(strategyId, runPromise)
        return runPromise
    }
}
