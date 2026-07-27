import {
    createExecutionError,
    createExecutionErrorDetail,
    formatExecutionError,
    type ExecutionResult,
} from "@valiq-trading/core"

export interface MT5AccountCredentials {
    login: number
    password: string
    server: string
}

export type MT5MarginModeName = "retail_hedging" | "retail_netting" | "exchange" | "unknown"

export interface MT5AccountInfo {
    login: number
    name: string
    server: string
    company: string
    balance: number
    equity: number
    margin: number
    freeMargin: number
    marginLevel: number
    currency: string
    leverage: number
    profit: number
    marginMode?: number
    marginModeName?: MT5MarginModeName
}

export interface MT5Position {
    ticket: number
    symbol: string
    type: "buy" | "sell"
    volume: number
    openPrice: number
    currentPrice: number
    stopLoss: number
    takeProfit: number
    profit: number
    swap: number
    commission: number
    magic: number
    comment: string
    openTime: number
    identifier: number
}

export interface MT5PositionClosure {
    ticket: number
    orderId: number
    positionId: number
    symbol: string
    side: "long" | "short"
    volume: number
    price: number
    profit: number
    swap?: number
    commission?: number
    fee?: number
    comment?: string
    timeDone: number
    entry: number
    reason: number
}

export interface MT5AccountPnlEvent {
    providerEventId: string
    eventType: "funding_fee" | "fee" | "adjustment"
    instrument?: string
    amount: number
    currency: string
    occurredAt: number
    metadata?: Record<string, unknown>
}

export interface MT5AccountStateSnapshot {
    account: MT5AccountInfo
    positionClosures: MT5PositionClosure[]
    accountPnlEvents: MT5AccountPnlEvent[]
}

export interface MT5OpenOrder {
    ticket: number
    symbol: string
    type: string
    volumeInitial: number
    volumeCurrent: number
    priceOpen: number
    stopLoss: number
    takeProfit: number
    state: string
    comment: string
    magic: number
    timeSetup: number
    timeDone: number
}

export interface MT5OrderResult {
    retcode: number
    retcodeDescription: string
    retcodeExternal?: number
    orderId: string
    dealId?: string
    volume: number
    price: number
    comment?: string
    bid?: number
    ask?: number
    success: boolean
    unresolved?: boolean
    commitUnknown?: boolean
    commandId?: string
    allowSuccessRetcodePromotion?: boolean
    providerStatus?: "placed" | "filled" | "partially_filled" | "canceled" | "expired" | "modified" | "rejected" | "unknown"
}

export interface MT5SymbolInfo {
    symbol: string
    digits: number
    point: number
    pipSize: number
    tickValue: number
    contractSize: number
    currency: string
    description: string
    spread: number
    volumeMin: number
    volumeMax: number
    volumeStep: number
    fillingMode: number
    bid: number
    ask: number
}

export interface MT5OrderStatus {
    ticket: number
    symbol: string
    type: string
    volume: number
    volumeInitial?: number
    price: number
    profit?: number
    commission?: number
    swap?: number
    fee?: number
    positionId?: number
    state: string
}

export class MT5Client {
    constructor(_config?: unknown) {
    }

    async connect(_credentials: MT5AccountCredentials): Promise<MT5AccountInfo> {
        throw unimplementedMT5TransportMethod("connect")
    }

    async disconnect(): Promise<void> {
        throw unimplementedMT5TransportMethod("disconnect")
    }

    async getHealth(_options: { timeout?: number } = {}): Promise<{ status: string; connected: boolean; login: number | null }> {
        throw unimplementedMT5TransportMethod("getHealth")
    }

    async getAccount(_credentials: MT5AccountCredentials): Promise<MT5AccountInfo> {
        throw unimplementedMT5TransportMethod("getAccount")
    }

    async getPositions(_credentials: MT5AccountCredentials): Promise<MT5Position[]> {
        throw unimplementedMT5TransportMethod("getPositions")
    }

    async getOpenOrders(_credentials: MT5AccountCredentials): Promise<MT5OpenOrder[]> {
        throw unimplementedMT5TransportMethod("getOpenOrders")
    }

    async getPositionClosures(
        _credentials: MT5AccountCredentials,
        _lookbackHours: number = 24
    ): Promise<MT5PositionClosure[]> {
        throw unimplementedMT5TransportMethod("getPositionClosures")
    }

    async getAccountPnlEvents(
        _credentials: MT5AccountCredentials,
        _lookbackHours: number = 24
    ): Promise<MT5AccountPnlEvent[]> {
        throw unimplementedMT5TransportMethod("getAccountPnlEvents")
    }

    async getAccountStateSnapshot(
        credentials: MT5AccountCredentials,
        lookbackHours: number = 24
    ): Promise<MT5AccountStateSnapshot> {
        const account = await this.getAccount(credentials)
        const [positionClosures, accountPnlEvents] = await Promise.all([
            this.getPositionClosures(credentials, lookbackHours),
            this.getAccountPnlEvents(credentials, lookbackHours),
        ])

        return {
            account,
            positionClosures,
            accountPnlEvents,
        }
    }

    async submitOrder(_credentials: MT5AccountCredentials, _params: {
        symbol: string
        side: string
        volume: number
        orderType?: string
        price?: number
        stopLoss?: number
        takeProfit?: number
        magic?: number
        comment?: string
        deviation?: number
    }): Promise<MT5OrderResult> {
        throw unimplementedMT5TransportMethod("submitOrder")
    }

    async modifyOrder(_credentials: MT5AccountCredentials, _params: {
        ticket: number
        price?: number
        stopLoss?: number
        takeProfit?: number
    }): Promise<MT5OrderResult> {
        throw unimplementedMT5TransportMethod("modifyOrder")
    }

    async cancelOrder(_credentials: MT5AccountCredentials, _params: {
        ticket: number
    }): Promise<MT5OrderResult> {
        throw unimplementedMT5TransportMethod("cancelOrder")
    }

    async closePosition(_credentials: MT5AccountCredentials, _params: {
        ticket: number
        volume?: number
        deviation?: number
        comment?: string
    }): Promise<MT5OrderResult> {
        throw unimplementedMT5TransportMethod("closePosition")
    }

    async getSymbolInfo(_credentials: MT5AccountCredentials, _symbols: string[]): Promise<MT5SymbolInfo[]> {
        throw unimplementedMT5TransportMethod("getSymbolInfo")
    }

    async getOrderStatus(_credentials: MT5AccountCredentials, _orderId: number): Promise<MT5OrderStatus | null> {
        throw unimplementedMT5TransportMethod("getOrderStatus")
    }

    mapOrderResultToExecution(
        result: MT5OrderResult,
        options: {
            fallbackOrderId?: string
            successStatus?: ExecutionResult["status"]
            filledQuantity?: number
            fillPrice?: number
            successRetcodes?: number[]
        } = {}
    ): ExecutionResult {
        if (result.unresolved) {
            const errorDetail = createExecutionErrorDetail(
                "venue",
                result.retcodeDescription || "MT5 mutation unresolved; needs manual reconciliation",
                {
                    code: "NEEDS_MANUAL_RECONCILIATION",
                    retryable: false,
                    details: {
                        retcode: result.retcode,
                        retcodeExternal: result.retcodeExternal,
                        comment: result.comment,
                        bid: result.bid,
                        ask: result.ask,
                        commandId: result.commandId,
                        unresolved: true,
                    },
                }
            )

            return {
                orderId: result.orderId || result.dealId || options.fallbackOrderId || "",
                providerOrderId: result.orderId || result.dealId || options.fallbackOrderId || undefined,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        const success = result.success || (
            result.allowSuccessRetcodePromotion !== false
            && (options.successRetcodes ?? []).includes(result.retcode)
        )
        const errorDetail = success
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
                    commandId: result.commandId,
                    commitUnknown: result.commitUnknown,
                },
            })

        return {
            orderId: result.orderId || result.dealId || options.fallbackOrderId || "",
            providerOrderId: result.orderId || result.dealId || options.fallbackOrderId || undefined,
            status: success
                ? options.successStatus ?? resolveMT5MutationSuccessStatus(result)
                : "rejected",
            filledQuantity: success ? options.filledQuantity ?? resolveMT5MutationFilledQuantity(result) : 0,
            fillPrice: success
                ? options.fillPrice ?? (result.price > 0 ? result.price : undefined)
                : undefined,
            timestamp: Date.now(),
            error: errorDetail ? formatExecutionError(errorDetail) : undefined,
            errorDetail,
        }
    }
}

function resolveMT5MutationSuccessStatus(result: MT5OrderResult): ExecutionResult["status"] {
    if (result.providerStatus === "placed" || result.providerStatus === "modified") {
        return "pending"
    }
    if (result.providerStatus === "canceled") {
        return "cancelled"
    }
    if (result.providerStatus === "expired") {
        return "expired"
    }
    if (result.providerStatus === "partially_filled" || result.retcode === 10010) {
        return "partially_filled"
    }
    return "filled"
}

function resolveMT5MutationFilledQuantity(result: MT5OrderResult): number {
    if (result.providerStatus === "placed" || result.providerStatus === "modified" || result.providerStatus === "canceled") {
        return 0
    }
    return result.volume
}

function unimplementedMT5TransportMethod(method: string): Error {
    return createExecutionError("venue", `MT5 ${method} requires FiveSocket client construction through createMT5Client`, {
        code: "MT5_CLIENT_NOT_CONFIGURED",
        retryable: false,
    })
}
