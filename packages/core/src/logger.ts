export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
}

export interface LogEntry {
    level: LogLevel
    message: string
    timestamp: string
    runId?: string
    strategyId?: string
    app?: string
    [key: string]: unknown
}

export interface LoggerConfig {
    minLevel?: LogLevel
    runId?: string
    strategyId?: string
    app?: string
}

export class Logger {
    private minLevel: number
    private baseFields: Record<string, unknown>

    constructor(config: LoggerConfig = {}) {
        this.minLevel = LEVEL_ORDER[config.minLevel ?? "info"]
        this.baseFields = {}
        if (config.runId) this.baseFields.runId = config.runId
        if (config.strategyId) this.baseFields.strategyId = config.strategyId
        if (config.app) this.baseFields.app = config.app
    }

    private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
        if (LEVEL_ORDER[level] < this.minLevel) return

        const entry: LogEntry = {
            level,
            message,
            timestamp: new Date().toISOString(),
            ...this.baseFields,
            ...extra,
        }

        const output = JSON.stringify(entry)

        if (LEVEL_ORDER[level] >= LEVEL_ORDER.error) {
            console.error(output)
        } else if (level === "warn") {
            console.warn(output)
        } else {
            console.log(output)
        }
    }

    debug(message: string, extra?: Record<string, unknown>): void {
        this.log("debug", message, extra)
    }

    info(message: string, extra?: Record<string, unknown>): void {
        this.log("info", message, extra)
    }

    warn(message: string, extra?: Record<string, unknown>): void {
        this.log("warn", message, extra)
    }

    error(message: string, extra?: Record<string, unknown>): void {
        this.log("error", message, extra)
    }

    fatal(message: string, extra?: Record<string, unknown>): void {
        this.log("fatal", message, extra)
    }

    child(fields: Record<string, unknown>): Logger {
        const child = new Logger()
        child.minLevel = this.minLevel
        child.baseFields = { ...this.baseFields, ...fields }
        return child
    }
}

export function createLogger(config: LoggerConfig = {}): Logger {
    return new Logger(config)
}
