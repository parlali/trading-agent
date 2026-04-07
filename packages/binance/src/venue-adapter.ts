import type { AccountState, ExecutionResult, OrderIntent, Position, VenueAdapter } from "@valiq-trading/core"
import {
    BinanceApiError,
    BinanceClient,
    type BinanceCreateOrderParams,
    type BinanceExchangeSymbol,
    type BinanceOrderResponse,
} from "./binance-client"
import type { BinanceMarketSnapshot } from "./market-context"

export interface BinanceSymbolRules {
    symbol: string
    minQty: number
    maxQty: number
    stepSize: number
    tickSize: number
    minNotional: number
    pricePrecision: number
    quantityPrecision: number
}

interface CompositeOrderId {
    symbol: string
    rawOrderId: number
}

export class BinanceVenueAdapter implements VenueAdapter {
    private readonly symbolRulesCache = new Map<string, BinanceSymbolRules>()
    private positionModeInitialized = false

    constructor(private readonly client: BinanceClient) {}

    async getPositions(): Promise<Position[]> {
        const positions = await this.client.getPositionRisk()

        return positions
            .map((position) => ({
                raw: position,
                quantity: Math.abs(Number(position.positionAmt)),
            }))
            .filter((entry) => entry.quantity > 0)
            .map(({ raw, quantity }) => ({
                instrument: raw.symbol,
                side: Number(raw.positionAmt) > 0 ? "long" : "short",
                quantity,
                entryPrice: Number(raw.entryPrice),
                currentPrice: Number(raw.markPrice),
                unrealizedPnl: Number(raw.unRealizedProfit),
                metadata: {
                    leverage: Number(raw.leverage),
                    marginType: raw.marginType,
                    liquidationPrice: Number(raw.liquidationPrice),
                },
            }))
    }

    async getAccountState(): Promise<AccountState> {
        const account = await this.client.getAccount()
        const walletBalance = Number(account.totalWalletBalance)
        const openPnl = Number(account.totalUnrealizedProfit)

        return {
            balance: walletBalance + openPnl,
            buyingPower: Number(account.availableBalance),
            marginUsed: Number(account.totalInitialMargin || account.totalMaintMargin),
            marginAvailable: Number(account.availableBalance),
            openPnl,
            dayPnl: 0,
        }
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        const symbol = intent.instrument.toUpperCase()
        const orderType = mapToBinanceOrderType(intent.orderType)
        const leverage = resolveLeverage(intent)

        if (!isCloseAction(intent)) {
            await this.ensureTradingMode(symbol, leverage)
        }

        const markPrice = await this.getCurrentMarkPrice(symbol)
        const notionalPrice = intent.limitPrice ?? markPrice
        const quantity = await this.normalizeQuantity(symbol, intent.quantity)

        if (quantity <= 0) {
            throw new Error(`Order quantity for ${symbol} is below exchange minimum`)
        }

        const rules = await this.getSymbolRules(symbol)
        if (quantity * notionalPrice < rules.minNotional) {
            throw new Error(`Order notional ${quantity * notionalPrice} is below minimum ${rules.minNotional} for ${symbol}`)
        }

        const payload: BinanceCreateOrderParams = {
            symbol,
            side: intent.side === "buy" ? "BUY" : "SELL",
            type: orderType,
            quantity,
            reduceOnly: isCloseAction(intent) ? true : undefined,
            price: intent.limitPrice ? await this.normalizePrice(symbol, intent.limitPrice) : undefined,
            stopPrice: intent.stopPrice ? await this.normalizePrice(symbol, intent.stopPrice) : undefined,
            timeInForce: shouldSendTimeInForce(orderType)
                ? mapTimeInForce(intent.timeInForce)
                : undefined,
        }

        const response = await this.client.createOrder(payload)
        return mapExecutionResult(symbol, response)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        const parsed = parseCompositeOrderId(orderId)
        if (!parsed) {
            throw new Error(`Unsupported Binance order id format: ${orderId}`)
        }

        const response = await this.client.cancelOrder(parsed.symbol, parsed.rawOrderId)
        return mapExecutionResult(parsed.symbol, response)
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        const parsed = parseCompositeOrderId(orderId)
        if (!parsed) {
            throw new Error(`Unsupported Binance order id format: ${orderId}`)
        }

        const existing = await this.client.getOrder(parsed.symbol, parsed.rawOrderId)
        await this.client.cancelOrder(parsed.symbol, parsed.rawOrderId)

        const originalQty = Number(existing.origQty)
        const executedQty = Number(existing.executedQty)
        const remainingQty = Math.max(originalQty - executedQty, 0)

        if (remainingQty <= 0) {
            return {
                orderId,
                status: "cancelled",
                filledQuantity: executedQty,
                fillPrice: Number(existing.avgPrice) > 0 ? Number(existing.avgPrice) : undefined,
                timestamp: Date.now(),
            }
        }

        const orderType = changes.orderType ?? mapFromBinanceOrderType(existing.type)
        const newIntent: OrderIntent = {
            instrument: parsed.symbol,
            side: changes.side ?? (existing.side === "BUY" ? "buy" : "sell"),
            quantity: changes.quantity ?? remainingQty,
            orderType,
            limitPrice: changes.limitPrice ?? (Number(existing.price) > 0 ? Number(existing.price) : undefined),
            stopPrice: changes.stopPrice ?? (Number(existing.stopPrice) > 0 ? Number(existing.stopPrice) : undefined),
            timeInForce: changes.timeInForce ?? "gtc",
            metadata: {
                action: "modify",
            },
        }

        return await this.submitOrder(newIntent)
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
        const symbol = instrument.toUpperCase()
        const positions = await this.getPositions()
        const position = positions.find((entry) => entry.instrument.toUpperCase() === symbol)

        if (!position) {
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: `No Binance futures position found for ${symbol}`,
            }
        }

        const side: "BUY" | "SELL" = position.side === "long" ? "SELL" : "BUY"
        const quantity = await this.normalizeQuantity(symbol, position.quantity)

        const response = await this.client.createOrder({
            symbol,
            side,
            type: "MARKET",
            quantity,
            reduceOnly: true,
        })

        return mapExecutionResult(symbol, response)
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const parsed = parseCompositeOrderId(orderId)
        if (!parsed) {
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: "Unsupported Binance order id format",
            }
        }

        const response = await this.client.getOrder(parsed.symbol, parsed.rawOrderId)
        return mapExecutionResult(parsed.symbol, response)
    }

    async getCurrentMarkPrice(symbol: string): Promise<number> {
        const premium = await this.client.getPremiumIndex(symbol.toUpperCase())
        return Number(premium.markPrice)
    }

    async getCurrentFundingRate(symbol: string): Promise<number> {
        const premium = await this.client.getPremiumIndex(symbol.toUpperCase())
        return Number(premium.lastFundingRate)
    }

    async getMarketSnapshot(symbols: string[]): Promise<BinanceMarketSnapshot[]> {
        const normalized = symbols.map((symbol) => symbol.toUpperCase())

        const snapshots = await Promise.all(
            normalized.map(async (symbol) => {
                const [bookTicker, premium] = await Promise.all([
                    this.client.getBookTicker(symbol),
                    this.client.getPremiumIndex(symbol),
                ])
                const bid = Number(bookTicker.bidPrice)
                const ask = Number(bookTicker.askPrice)
                const markPrice = Number(premium.markPrice)
                const spreadPercent = markPrice > 0
                    ? ((ask - bid) / markPrice) * 100
                    : 0

                return {
                    instrument: symbol,
                    bid,
                    ask,
                    markPrice,
                    spreadPercent,
                    fundingRate: Number(premium.lastFundingRate),
                } satisfies BinanceMarketSnapshot
            })
        )

        return snapshots
    }

    async normalizeQuantity(symbol: string, quantity: number): Promise<number> {
        const rules = await this.getSymbolRules(symbol.toUpperCase())
        const stepDecimals = countDecimals(rules.stepSize)
        const normalized = Number((Math.floor(quantity / rules.stepSize) * rules.stepSize).toFixed(stepDecimals))

        if (normalized < rules.minQty) {
            return 0
        }

        if (normalized > rules.maxQty) {
            return Number(rules.maxQty.toFixed(stepDecimals))
        }

        return normalized
    }

    async normalizePrice(symbol: string, price: number): Promise<number> {
        const rules = await this.getSymbolRules(symbol.toUpperCase())
        const tickDecimals = countDecimals(rules.tickSize)
        return Number((Math.round(price / rules.tickSize) * rules.tickSize).toFixed(tickDecimals))
    }

    async updateProtectionOrders(config: {
        instrument: string
        stopLoss?: number
        takeProfit?: number
    }): Promise<{ cancelledOrderIds: string[]; createdOrderIds: string[] }> {
        const symbol = config.instrument.toUpperCase()
        const positions = await this.getPositions()
        const position = positions.find((entry) => entry.instrument.toUpperCase() === symbol)

        if (!position) {
            throw new Error(`No open position found for ${symbol}`)
        }

        const existingOrders = await this.client.getOpenOrders(symbol)
        const protectionOrders = existingOrders.filter((order) =>
            order.reduceOnly && (
                order.type === "STOP_MARKET" ||
                order.type === "TAKE_PROFIT_MARKET" ||
                order.type === "STOP" ||
                order.type === "TAKE_PROFIT"
            )
        )

        const cancelledOrderIds: string[] = []
        for (const order of protectionOrders) {
            const cancelled = await this.client.cancelOrder(symbol, order.orderId)
            cancelledOrderIds.push(toCompositeOrderId(symbol, cancelled.orderId))
        }

        const closeSide: "BUY" | "SELL" = position.side === "long" ? "SELL" : "BUY"
        const createdOrderIds: string[] = []

        if (config.stopLoss !== undefined) {
            const stopLossOrder = await this.client.createOrder({
                symbol,
                side: closeSide,
                type: "STOP_MARKET",
                stopPrice: await this.normalizePrice(symbol, config.stopLoss),
                closePosition: true,
                workingType: "MARK_PRICE",
            })
            createdOrderIds.push(toCompositeOrderId(symbol, stopLossOrder.orderId))
        }

        if (config.takeProfit !== undefined) {
            const takeProfitOrder = await this.client.createOrder({
                symbol,
                side: closeSide,
                type: "TAKE_PROFIT_MARKET",
                stopPrice: await this.normalizePrice(symbol, config.takeProfit),
                closePosition: true,
                workingType: "MARK_PRICE",
            })
            createdOrderIds.push(toCompositeOrderId(symbol, takeProfitOrder.orderId))
        }

        return {
            cancelledOrderIds,
            createdOrderIds,
        }
    }

    async closeAllPositions(): Promise<{ closed: number; results: ExecutionResult[] }> {
        const positions = await this.getPositions()
        const results: ExecutionResult[] = []

        for (const position of positions) {
            results.push(await this.closePosition(position.instrument))
        }

        return {
            closed: results.filter((result) => result.status === "filled" || result.status === "pending").length,
            results,
        }
    }

    private async ensureTradingMode(symbol: string, leverage?: number): Promise<void> {
        if (!this.positionModeInitialized) {
            try {
                await this.client.setPositionMode(false)
            } catch (error) {
                if (!(error instanceof BinanceApiError) || error.code !== -4059) {
                    throw error
                }
            }
            this.positionModeInitialized = true
        }

        try {
            await this.client.setMarginType(symbol, "ISOLATED")
        } catch (error) {
            if (!(error instanceof BinanceApiError) || error.code !== -4046) {
                throw error
            }
        }

        if (leverage !== undefined) {
            await this.client.setLeverage(symbol, leverage)
        }
    }

    private async getSymbolRules(symbol: string): Promise<BinanceSymbolRules> {
        const cached = this.symbolRulesCache.get(symbol)
        if (cached) {
            return cached
        }

        const exchangeInfo = await this.client.getExchangeInfo()
        const symbolInfo = exchangeInfo.symbols.find((entry) => entry.symbol === symbol)

        if (!symbolInfo) {
            throw new Error(`Binance symbol not found in exchangeInfo: ${symbol}`)
        }

        const rules = parseSymbolRules(symbolInfo)
        this.symbolRulesCache.set(symbol, rules)
        return rules
    }
}

function mapExecutionResult(symbol: string, order: BinanceOrderResponse): ExecutionResult {
    const fillPrice = Number(order.avgPrice) > 0
        ? Number(order.avgPrice)
        : Number(order.price) > 0
            ? Number(order.price)
            : undefined

    return {
        orderId: toCompositeOrderId(symbol, order.orderId),
        status: mapOrderStatus(order.status),
        filledQuantity: Number(order.executedQty),
        fillPrice,
        timestamp: order.updateTime ?? order.time ?? Date.now(),
        error: mapOrderStatus(order.status) === "rejected" ? order.status : undefined,
    }
}

function mapOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "NEW":
            return "pending"
        case "PARTIALLY_FILLED":
            return "partially_filled"
        case "FILLED":
            return "filled"
        case "CANCELED":
            return "cancelled"
        case "EXPIRED":
            return "expired"
        case "REJECTED":
            return "rejected"
        default:
            return "pending"
    }
}

function mapToBinanceOrderType(
    orderType: OrderIntent["orderType"]
): BinanceCreateOrderParams["type"] {
    switch (orderType) {
        case "market":
            return "MARKET"
        case "limit":
            return "LIMIT"
        case "stop":
            return "STOP_MARKET"
        case "stop_limit":
            return "STOP"
        default:
            return "MARKET"
    }
}

function mapFromBinanceOrderType(
    orderType: string
): OrderIntent["orderType"] {
    switch (orderType) {
        case "MARKET":
            return "market"
        case "LIMIT":
            return "limit"
        case "STOP":
            return "stop_limit"
        case "STOP_MARKET":
            return "stop"
        default:
            return "limit"
    }
}

function mapTimeInForce(timeInForce: OrderIntent["timeInForce"]): "GTC" | "IOC" | "FOK" | "GTX" {
    switch (timeInForce) {
        case "ioc":
            return "IOC"
        case "fok":
            return "FOK"
        case "day":
        case "gtc":
        default:
            return "GTC"
    }
}

function shouldSendTimeInForce(orderType: BinanceCreateOrderParams["type"]): boolean {
    return orderType === "LIMIT" || orderType === "STOP" || orderType === "TAKE_PROFIT"
}

function parseSymbolRules(symbol: BinanceExchangeSymbol): BinanceSymbolRules {
    const lotFilter = symbol.filters.find((filter) => filter.filterType === "LOT_SIZE")
    const priceFilter = symbol.filters.find((filter) => filter.filterType === "PRICE_FILTER")
    const minNotionalFilter = symbol.filters.find((filter) => filter.filterType === "MIN_NOTIONAL")

    if (!lotFilter || !priceFilter) {
        throw new Error(`Missing LOT_SIZE or PRICE_FILTER for symbol ${symbol.symbol}`)
    }

    const minNotional = Number(minNotionalFilter?.notional ?? minNotionalFilter?.minNotional ?? "0")

    return {
        symbol: symbol.symbol,
        minQty: Number(lotFilter.minQty),
        maxQty: Number(lotFilter.maxQty),
        stepSize: Number(lotFilter.stepSize),
        tickSize: Number(priceFilter.tickSize),
        minNotional,
        pricePrecision: symbol.pricePrecision,
        quantityPrecision: symbol.quantityPrecision,
    }
}

function countDecimals(value: number): number {
    const asString = value.toString()
    const dotIndex = asString.indexOf(".")
    if (dotIndex === -1) {
        return 0
    }
    return asString.length - dotIndex - 1
}

function parseCompositeOrderId(orderId: string): CompositeOrderId | null {
    const parts = orderId.split(":")
    if (parts.length !== 2) {
        return null
    }

    const symbol = parts[0]
    const rawOrderId = Number(parts[1])
    if (!symbol || !Number.isFinite(rawOrderId)) {
        return null
    }

    return {
        symbol,
        rawOrderId,
    }
}

function toCompositeOrderId(symbol: string, orderId: number): string {
    return `${symbol}:${orderId}`
}

function isCloseAction(intent: OrderIntent): boolean {
    const action = intent.metadata?.action
    return action === "close" || action === "cancel" || action === "cancel_order"
}

function resolveLeverage(intent: OrderIntent): number | undefined {
    const leverage = intent.metadata?.leverage
    if (typeof leverage !== "number") {
        return undefined
    }
    return Math.floor(leverage)
}
