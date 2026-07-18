import type {
    MT5AccountInfo,
    MT5AccountPnlEvent,
    MT5OpenOrder,
    MT5OrderResult,
    MT5Position,
    MT5PositionClosure,
    MT5SymbolInfo,
} from "./mt5-client"
import {
    fromDecimalString,
    fromOptionalDecimalString,
    fromOptionalUnsignedIntString,
    fromUnsignedIntString,
} from "./fivesocket-decimals"

export type FiveSocketExecutionOutcome =
    | "accepted"
    | "rejected"
    | "commit_unknown"
    | "unresolved"

export type FiveSocketExecutionStatus =
    | "placed"
    | "filled"
    | "partially_filled"
    | "canceled"
    | "expired"
    | "modified"
    | "rejected"
    | "unknown"

export interface FiveSocketExecutionCommand {
    commandId: string
    operation: string
    outcome: FiveSocketExecutionOutcome
    status: FiveSocketExecutionStatus
    retcode: number | null
    retcodeExternal: number | null
    retcodeDescription: string
    orderId?: string
    dealId?: string
    positionId?: string
    clientOrderId?: string
    volume: string
    price: string
    bid?: string
    ask?: string
    recovered: boolean
    observedAt: string
    latencyMs: number
}

export interface FiveSocketBalance {
    accountId: string
    login: string
    server: string
    balance: string
    equity: string
    currency: string
    margin: string
    marginFree: string
    profit: string
    leverage: string
    name: string
    company: string
}

export interface FiveSocketPosition {
    id: string
    identifier?: string
    symbol: string
    side: "buy" | "sell"
    volume: string
    openPrice: string
    currentPrice: string
    profit: string
    openedAt: string
    stopLoss?: string
    takeProfit?: string
    swap: string
    magic: string
    comment?: string
}

export interface FiveSocketWorkingOrder {
    id: string
    positionId: string
    symbol: string
    type: string
    state: string
    volumeInitial: string
    volumeCurrent: string
    priceOpen: string
    stopLoss?: string
    takeProfit?: string
    setupAt: string
    doneAt?: string
    magic: string
    comment?: string
}

export interface FiveSocketDeal {
    id: string
    orderId: string
    positionId: string
    symbol: string
    type: string
    entry: string
    volume: string
    price: string
    profit: string
    commission: string
    swap: string
    fee: string
    magic: string
    comment?: string
    time: string
    rawReason?: number
}

export interface FiveSocketExecutionSymbol {
    symbol: string
    description?: string
    digits: number
    point: string
    contractSize: string
    tickSize: string
    tickValue: string
    currencyBase: string
    currencyProfit: string
    volumeMin: string
    volumeMax: string
    volumeStep: string
    bid: string
    ask: string
    spreadPoints: number
    fillingMode: number
}

export interface FiveSocketApiReadiness {
    status: "ready" | "warming" | "unavailable"
    checkedAt: string
}

export function mapFiveSocketBalanceToAccountInfo(balance: FiveSocketBalance): MT5AccountInfo {
    const margin = fromDecimalString(balance.margin, "margin")
    const marginFree = fromDecimalString(balance.marginFree, "marginFree")
    const equity = fromDecimalString(balance.equity, "equity")

    return {
        login: fromUnsignedIntString(balance.login, "login"),
        name: balance.name,
        server: balance.server,
        company: balance.company,
        balance: fromDecimalString(balance.balance, "balance"),
        equity,
        margin,
        freeMargin: marginFree,
        marginLevel: margin > 0 ? (equity / margin) * 100 : 0,
        currency: balance.currency,
        leverage: fromUnsignedIntString(balance.leverage, "leverage"),
        profit: fromDecimalString(balance.profit, "profit"),
    }
}

export function mapFiveSocketPosition(position: FiveSocketPosition): MT5Position {
    const ticket = fromUnsignedIntString(position.id, "position.id")
    const identifier = fromOptionalUnsignedIntString(position.identifier) ?? ticket

    return {
        ticket,
        symbol: position.symbol,
        type: position.side,
        volume: fromDecimalString(position.volume, "position.volume"),
        openPrice: fromDecimalString(position.openPrice, "position.openPrice"),
        currentPrice: fromDecimalString(position.currentPrice, "position.currentPrice"),
        stopLoss: fromOptionalDecimalString(position.stopLoss) ?? 0,
        takeProfit: fromOptionalDecimalString(position.takeProfit) ?? 0,
        profit: fromDecimalString(position.profit, "position.profit"),
        swap: fromDecimalString(position.swap, "position.swap"),
        commission: 0,
        magic: fromUnsignedIntString(position.magic, "position.magic"),
        comment: position.comment ?? "",
        openTime: Date.parse(position.openedAt) || 0,
        identifier,
    }
}

export function mapFiveSocketWorkingOrder(order: FiveSocketWorkingOrder): MT5OpenOrder {
    return {
        ticket: fromUnsignedIntString(order.id, "order.id"),
        symbol: order.symbol,
        type: order.type,
        volumeInitial: fromDecimalString(order.volumeInitial, "order.volumeInitial"),
        volumeCurrent: fromDecimalString(order.volumeCurrent, "order.volumeCurrent"),
        priceOpen: fromDecimalString(order.priceOpen, "order.priceOpen"),
        stopLoss: fromOptionalDecimalString(order.stopLoss) ?? 0,
        takeProfit: fromOptionalDecimalString(order.takeProfit) ?? 0,
        state: order.state,
        comment: order.comment ?? "",
        magic: fromUnsignedIntString(order.magic, "order.magic"),
        timeSetup: Date.parse(order.setupAt) || 0,
        timeDone: order.doneAt ? Date.parse(order.doneAt) || 0 : 0,
    }
}

export function mapFiveSocketDealToClosure(deal: FiveSocketDeal): MT5PositionClosure | null {
    if (deal.entry !== "out" && deal.entry !== "inout" && deal.entry !== "out_by") {
        return null
    }

    if (deal.type !== "buy" && deal.type !== "sell") {
        return null
    }

    return {
        ticket: fromUnsignedIntString(deal.id, "deal.id"),
        orderId: fromUnsignedIntString(deal.orderId, "deal.orderId"),
        positionId: fromUnsignedIntString(deal.positionId, "deal.positionId"),
        symbol: deal.symbol,
        side: deal.type === "buy" ? "long" : "short",
        volume: fromDecimalString(deal.volume, "deal.volume"),
        price: fromDecimalString(deal.price, "deal.price"),
        profit: fromDecimalString(deal.profit, "deal.profit"),
        swap: fromDecimalString(deal.swap, "deal.swap"),
        commission: fromDecimalString(deal.commission, "deal.commission"),
        fee: fromDecimalString(deal.fee, "deal.fee"),
        comment: deal.comment,
        timeDone: Date.parse(deal.time) || 0,
        entry: deal.entry === "out" ? 1 : deal.entry === "inout" ? 2 : 3,
        reason: typeof deal.rawReason === "number" ? deal.rawReason : 0,
    }
}

export function mapFiveSocketDealToPnlEvent(
    deal: FiveSocketDeal,
    currency: string
): MT5AccountPnlEvent | null {
    const eventType = resolvePnlEventType(deal.type)
    if (!eventType) {
        return null
    }

    return {
        providerEventId: deal.id,
        eventType,
        instrument: deal.symbol || undefined,
        amount: fromDecimalString(deal.profit, "deal.profit"),
        currency,
        occurredAt: Date.parse(deal.time) || 0,
        metadata: {
            dealType: deal.type,
            orderId: deal.orderId,
            positionId: deal.positionId,
            comment: deal.comment,
        },
    }
}

export function mapFiveSocketExecutionSymbol(symbol: FiveSocketExecutionSymbol): MT5SymbolInfo {
    const point = fromDecimalString(symbol.point, "symbol.point")
    const bid = fromDecimalString(symbol.bid, "symbol.bid")
    const ask = fromDecimalString(symbol.ask, "symbol.ask")

    return {
        symbol: symbol.symbol,
        digits: symbol.digits,
        point,
        pipSize: point * 10,
        tickValue: fromDecimalString(symbol.tickValue, "symbol.tickValue"),
        contractSize: fromDecimalString(symbol.contractSize, "symbol.contractSize"),
        currency: symbol.currencyProfit || symbol.currencyBase,
        description: symbol.description ?? "",
        spread: Math.abs(ask - bid),
        volumeMin: fromDecimalString(symbol.volumeMin, "symbol.volumeMin"),
        volumeMax: fromDecimalString(symbol.volumeMax, "symbol.volumeMax"),
        volumeStep: fromDecimalString(symbol.volumeStep, "symbol.volumeStep"),
        fillingMode: symbol.fillingMode,
        bid,
        ask,
    }
}

export function mapFiveSocketExecutionCommand(
    command: FiveSocketExecutionCommand
): MT5OrderResult {
    const volume = fromDecimalString(command.volume, "command.volume")
    const price = fromDecimalString(command.price, "command.price")
    const comment = command.clientOrderId
    const base = {
        retcodeExternal: command.retcodeExternal ?? undefined,
        orderId: command.orderId ?? "",
        dealId: command.dealId,
        volume,
        price,
        comment,
        bid: fromOptionalDecimalString(command.bid),
        ask: fromOptionalDecimalString(command.ask),
        commandId: command.commandId,
        providerStatus: command.status,
    }

    if (command.outcome === "rejected" || command.status === "rejected") {
        return {
            ...base,
            retcode: command.retcode ?? 10013,
            retcodeDescription: command.retcodeDescription,
            success: false,
            allowSuccessRetcodePromotion: false,
        }
    }

    if (command.outcome === "unresolved") {
        return {
            ...base,
            retcode: command.retcode ?? -1,
            retcodeDescription: command.retcodeDescription || "FiveSocket mutation unresolved; needs manual reconciliation",
            success: false,
            unresolved: true,
            allowSuccessRetcodePromotion: false,
        }
    }

    if (command.outcome === "commit_unknown") {
        return {
            ...base,
            retcode: command.retcode ?? -1,
            retcodeDescription: command.retcodeDescription || "FiveSocket commit unknown",
            success: false,
            commitUnknown: true,
            allowSuccessRetcodePromotion: false,
        }
    }

    if (command.status === "filled") {
        return {
            ...base,
            retcode: command.retcode ?? 10009,
            retcodeDescription: command.retcodeDescription,
            success: true,
        }
    }

    if (command.status === "partially_filled") {
        return {
            ...base,
            retcode: command.retcode ?? 10010,
            retcodeDescription: command.retcodeDescription,
            success: true,
        }
    }

    if (command.status === "placed" || command.status === "modified") {
        return {
            ...base,
            retcode: command.retcode ?? (command.status === "placed" ? 10008 : 10025),
            retcodeDescription: command.retcodeDescription,
            success: true,
        }
    }

    if (command.status === "canceled") {
        return {
            ...base,
            retcode: command.retcode ?? 10009,
            retcodeDescription: command.retcodeDescription,
            success: true,
        }
    }

    return {
        ...base,
        retcode: command.retcode ?? -1,
        retcodeDescription: command.retcodeDescription || `FiveSocket accepted with non-fill status ${command.status}`,
        success: false,
        allowSuccessRetcodePromotion: false,
    }
}

export function mapFiveSocketReadiness(readiness: FiveSocketApiReadiness, login: number | null = null): {
    status: string
    connected: boolean
    login: number | null
} {
    return {
        status: readiness.status,
        connected: readiness.status === "ready",
        login,
    }
}

function resolvePnlEventType(dealType: string): MT5AccountPnlEvent["eventType"] | null {
    switch (dealType) {
        case "interest":
            return "funding_fee"
        case "commission":
        case "commission_daily":
        case "commission_monthly":
        case "agent_daily":
        case "agent_monthly":
        case "fee":
        case "tax":
            return "fee"
        case "balance":
        case "credit":
        case "charge":
        case "correction":
        case "bonus":
        case "dividend":
        case "dividend_franked":
            return "adjustment"
        default:
            return null
    }
}
