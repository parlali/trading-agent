const LEVEL_ORDER = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
};
export class Logger {
    minLevel;
    baseFields;
    constructor(config = {}) {
        this.minLevel = LEVEL_ORDER[config.minLevel ?? "info"];
        this.baseFields = {};
        if (config.runId)
            this.baseFields.runId = config.runId;
        if (config.strategyId)
            this.baseFields.strategyId = config.strategyId;
        if (config.app)
            this.baseFields.app = config.app;
    }
    log(level, message, extra) {
        if (LEVEL_ORDER[level] < this.minLevel)
            return;
        const entry = {
            level,
            message,
            timestamp: new Date().toISOString(),
            ...this.baseFields,
            ...extra,
        };
        const output = JSON.stringify(entry);
        if (LEVEL_ORDER[level] >= LEVEL_ORDER.error) {
            console.error(output);
        }
        else if (level === "warn") {
            console.warn(output);
        }
        else {
            console.log(output);
        }
    }
    debug(message, extra) {
        this.log("debug", message, extra);
    }
    info(message, extra) {
        this.log("info", message, extra);
    }
    warn(message, extra) {
        this.log("warn", message, extra);
    }
    error(message, extra) {
        this.log("error", message, extra);
    }
    fatal(message, extra) {
        this.log("fatal", message, extra);
    }
    child(fields) {
        const child = new Logger();
        child.minLevel = this.minLevel;
        child.baseFields = { ...this.baseFields, ...fields };
        return child;
    }
}
export function createLogger(config = {}) {
    return new Logger(config);
}
