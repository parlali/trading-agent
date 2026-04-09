import type { Logger } from "./logger";
export declare function cronMatchesDate(expression: string, date: Date): boolean;
export declare function getNextCronFireMs(expression: string, from?: Date): number | null;
export type ScheduleType = "cron" | "interval" | "oneshot";
export interface ScheduledStrategy {
    strategyId: string;
    scheduleType: ScheduleType;
    cronExpression?: string;
    intervalMs?: number;
    handler: () => Promise<void>;
}
export declare const DEFAULT_STALE_RUN_TIMEOUT_MS: number;
export interface SchedulerConfig {
    tickInterval?: number;
    staleRunTimeoutMs?: number;
    logger: Logger;
}
export declare class Scheduler {
    private strategies;
    private cronTicker;
    private tickInterval;
    private staleRunTimeoutMs;
    private logger;
    private shuttingDown;
    private inFlightRuns;
    constructor(config: SchedulerConfig);
    register(config: ScheduledStrategy): void;
    unregister(strategyId: string): void;
    start(): void;
    triggerManual(strategyId: string): Promise<void>;
    shutdown(): Promise<void>;
    getRegisteredStrategies(): string[];
    isRunning(strategyId: string): boolean;
    scheduleOneshot(parentStrategyId: string, delayMs: number, handler: () => Promise<void>): void;
    private tick;
    private triggerStrategy;
}
//# sourceMappingURL=scheduler.d.ts.map