/**
 * MT5 HTTP client -- communicates with the Python worker over HTTP.
 *
 * The Python worker wraps the MT5 SDK. This client proxies the VenueAdapter
 * interface calls to the worker's REST endpoints.
 */
import { createExecutionError, createExecutionErrorDetail, fetchWithTimeout, formatExecutionError, retryWithBackoff, } from "@valiq-trading/core";
export class MT5Client {
    workerUrl;
    accessKey;
    timeout;
    connected = false;
    constructor(config) {
        this.workerUrl = config.workerUrl.replace(/\/$/, "");
        this.accessKey = config.accessKey ?? "";
        this.timeout = config.timeout ?? 30_000;
    }
    async connect(credentials) {
        const response = await this.post("/connect", credentials);
        if (!response.success) {
            throw new Error(`MT5 connection failed (${response.errorType ?? "unknown"}): ${response.error ?? "unknown error"}`);
        }
        this.connected = true;
        return response.accountInfo;
    }
    async disconnect() {
        try {
            await this.post("/disconnect", {});
        }
        catch {
            // Best effort
        }
        this.connected = false;
    }
    async getHealth() {
        return await this.get("/health");
    }
    async getAccount() {
        return await this.get("/account");
    }
    async getPositions() {
        return await this.get("/positions");
    }
    async getOpenOrders() {
        return await this.get("/orders");
    }
    async submitOrder(params) {
        return await this.post("/order/submit", params);
    }
    async modifyPosition(params) {
        return await this.post("/order/modify", params);
    }
    async cancelOrder(params) {
        return await this.post("/order/cancel", params);
    }
    async closePosition(params) {
        return await this.post("/position/close", params);
    }
    async closeAllPositions() {
        return await this.post("/position/close-all", {});
    }
    async getSymbolInfo(symbols) {
        return await this.post("/symbol/info", { symbols });
    }
    async getOrderStatus(orderId) {
        try {
            return await this.post("/order/status", { orderId });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("404")) {
                return null;
            }
            throw error;
        }
    }
    // -- Mapping helpers for VenueAdapter -------------------------------------
    mapOrderResultToExecution(result, options = {}) {
        const errorDetail = result.success
            ? undefined
            : createExecutionErrorDetail("venue", result.retcodeDescription, {
                code: String(result.retcode),
                retryable: result.retcode === 10004 || result.retcode === 10020 || result.retcode === 10024 || result.retcode === 10031,
                details: {
                    retcode: result.retcode,
                    retcodeExternal: result.retcodeExternal,
                    comment: result.comment,
                    bid: result.bid,
                    ask: result.ask,
                },
            });
        return {
            orderId: result.orderId || result.dealId || options.fallbackOrderId || "",
            status: result.success ? options.successStatus ?? "filled" : "rejected",
            filledQuantity: result.success ? options.filledQuantity ?? result.volume : 0,
            fillPrice: result.success
                ? options.fillPrice ?? (result.price > 0 ? result.price : undefined)
                : undefined,
            timestamp: Date.now(),
            error: errorDetail ? formatExecutionError(errorDetail) : undefined,
            errorDetail,
        };
    }
    // -- HTTP transport -------------------------------------------------------
    async get(path) {
        return await retryWithBackoff(async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);
            try {
                const response = await fetchWithTimeout(`${this.workerUrl}${path}`, {
                    method: "GET",
                    headers: this.headers(),
                    signal: controller.signal,
                }, this.timeout, `MT5 worker GET ${path}`);
                if (!response.ok) {
                    const body = await response.text().catch(() => "");
                    throw createExecutionError("venue", `MT5 worker error: ${response.status} ${response.statusText} ${body}`.trim(), {
                        code: String(response.status),
                        retryable: response.status >= 500 || response.status === 429,
                        details: {
                            path,
                            status: response.status,
                            statusText: response.statusText,
                            body,
                        },
                    });
                }
                return (await response.json());
            }
            finally {
                clearTimeout(timeoutId);
            }
        }, 3, 1000);
    }
    async post(path, body) {
        return await retryWithBackoff(async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);
            try {
                const response = await fetchWithTimeout(`${this.workerUrl}${path}`, {
                    method: "POST",
                    headers: this.headers(),
                    body: JSON.stringify(body),
                    signal: controller.signal,
                }, this.timeout, `MT5 worker POST ${path}`);
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    throw createExecutionError("venue", `MT5 worker error: ${response.status} ${response.statusText} ${text}`.trim(), {
                        code: String(response.status),
                        retryable: response.status >= 500 || response.status === 429,
                        details: {
                            path,
                            status: response.status,
                            statusText: response.statusText,
                            body: text,
                        },
                    });
                }
                return (await response.json());
            }
            finally {
                clearTimeout(timeoutId);
            }
        }, 3, 1000);
    }
    headers() {
        const h = { "Content-Type": "application/json" };
        if (this.accessKey) {
            h["x-worker-key"] = this.accessKey;
        }
        return h;
    }
}
