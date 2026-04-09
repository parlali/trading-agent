export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
    runId?: string;
    strategyId?: string;
    app?: string;
    [key: string]: unknown;
}
export interface LoggerConfig {
    minLevel?: LogLevel;
    runId?: string;
    strategyId?: string;
    app?: string;
}
export declare class Logger {
    private minLevel;
    private baseFields;
    constructor(config?: LoggerConfig);
    private log;
    debug(message: string, extra?: Record<string, unknown>): void;
    info(message: string, extra?: Record<string, unknown>): void;
    warn(message: string, extra?: Record<string, unknown>): void;
    error(message: string, extra?: Record<string, unknown>): void;
    fatal(message: string, extra?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): Logger;
}
export declare function createLogger(config?: LoggerConfig): Logger;
//# sourceMappingURL=logger.d.ts.map