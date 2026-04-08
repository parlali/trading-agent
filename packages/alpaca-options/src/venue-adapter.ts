import {
    createExecutionError,
    type AccountState,
    type ExecutionResult,
    type OrderIntent,
    type Position,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import { AlpacaClient, type AlpacaPositionResponse } from "./alpaca-client"
import { buildIronCondorInstrument, parseOptionContractSymbol } from "./risk-rules"

interface PositionGroup {
    instrument: string
    underlying: string
    expiration: string
    quantity: number
    positions: AlpacaPositionResponse[]
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
}

export class AlpacaOptionsVenueAdapter implements VenueAdapter {
    constructor(private readonly client: AlpacaClient) {}

    async getPositions(): Promise<Position[]> {
        const rawPositions = await this.client.getPositions()
        const optionPositions = rawPositions.filter((position) => {
            return position.asset_class === undefined || position.asset_class === "us_option"
        })

        const grouped = groupIronCondorPositions(optionPositions)
        const groupedInstruments = new Set(grouped.flatMap((group) => group.positions.map((position) => position.symbol)))

        const individual = optionPositions
            .filter((position) => !groupedInstruments.has(position.symbol))
            .map((position) => mapSinglePosition(position))

        return [...grouped.map(mapGroupedPosition), ...individual]
    }

    async getAccountState(): Promise<AccountState> {
        const account = await this.client.getAccount()
        const equity = toNumber(account.equity) || toNumber(account.portfolio_value)
        const balance = toNumber(account.cash)
        const previousBalance = toNumber(account.last_equity)
        const openPnl = toNumber(account.unrealized_pl)

        return {
            balance,
            equity,
            buyingPower: toNumber(account.buying_power) || toNumber(account.regt_buying_power),
            marginUsed: toNumber(account.initial_margin) || toNumber(account.maintenance_margin),
            marginAvailable: Math.max((toNumber(account.buying_power) || 0) - (toNumber(account.initial_margin) || 0), 0),
            openPnl,
            dayPnl: previousBalance > 0 ? equity - previousBalance : 0,
        }
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const orders = await this.client.getOpenOrders()
        return orders.map((order) => mapWorkingOrder(order))
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        return await this.client.createOrder(intent)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        return await this.client.cancelOrder(orderId)
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        return await this.client.replaceOrder(orderId, changes)
    }

    async buildCloseIntent(instrument: string): Promise<OrderIntent> {
        const rawPositions = await this.client.getPositions()
        const group = resolveGroupForClose(rawPositions, instrument)

        if (!group) {
            throw createExecutionError("pre_validation", `No Alpaca options structure found for ${instrument}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument,
                },
            })
        }

        return {
            instrument: group.instrument,
            side: "buy",
            quantity: group.quantity,
            orderType: "limit",
            limitPrice: roundPrice(group.currentPrice ?? group.entryPrice),
            timeInForce: "day",
            legs: group.positions.map((position) => ({
                instrument: position.symbol,
                side: position.side === "long" ? "sell_to_close" : "buy_to_close",
                quantity: 1,
            })),
            metadata: {
                action: "close",
                underlying: group.underlying,
                expiration: group.expiration,
            },
        }
    }

    async closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult> {
        const closeIntent = preparedIntent ?? await this.buildCloseIntent(instrument)
        return await this.client.createOrder(closeIntent)
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        return await this.client.getOrder(orderId)
    }
}

function groupIronCondorPositions(positions: AlpacaPositionResponse[]): PositionGroup[] {
    const groups = new Map<string, AlpacaPositionResponse[]>()

    for (const position of positions) {
        const parsed = parseOptionContractSymbol(position.symbol)
        if (!parsed) {
            continue
        }

        const quantity = Math.abs(toNumber(position.qty))
        const key = `${parsed.underlying}:${parsed.expiration}:${quantity}`
        const entry = groups.get(key)

        if (entry) {
            entry.push(position)
        } else {
            groups.set(key, [position])
        }
    }

    const results: PositionGroup[] = []

    for (const [key, groupedPositions] of groups) {
        if (!isIronCondorGroup(groupedPositions)) {
            continue
        }

        const [underlying, expiration, quantityString] = key.split(":")
        const quantity = Number(quantityString)
        const entryPrice = groupedPositions.reduce((sum, position) => sum + toNumber(position.avg_entry_price), 0)
        const currentPrice = groupedPositions.reduce((sum, position) => sum + toNumber(position.current_price), 0)
        const unrealizedPnl = groupedPositions.reduce((sum, position) => sum + toNumber(position.unrealized_pl), 0)

        results.push({
            instrument: buildIronCondorInstrument(underlying ?? "UNKNOWN", expiration ?? "", quantity),
            underlying: underlying ?? "UNKNOWN",
            expiration: expiration ?? "",
            quantity,
            positions: groupedPositions,
            entryPrice: roundPrice(Math.abs(entryPrice)),
            currentPrice: currentPrice > 0 ? roundPrice(Math.abs(currentPrice)) : undefined,
            unrealizedPnl,
        })
    }

    return results
}

function isIronCondorGroup(positions: AlpacaPositionResponse[]): boolean {
    if (positions.length !== 4) {
        return false
    }

    const parsed = positions
        .map((position) => parseOptionContractSymbol(position.symbol))
        .filter((value): value is NonNullable<ReturnType<typeof parseOptionContractSymbol>> => Boolean(value))

    if (parsed.length !== 4) {
        return false
    }

    const calls = positions.filter((position) => parseOptionContractSymbol(position.symbol)?.optionType === "call")
    const puts = positions.filter((position) => parseOptionContractSymbol(position.symbol)?.optionType === "put")
    const longCount = positions.filter((position) => position.side === "long").length
    const shortCount = positions.filter((position) => position.side === "short").length

    return calls.length === 2 && puts.length === 2 && longCount === 2 && shortCount === 2
}

function mapGroupedPosition(group: PositionGroup): Position {
    return {
        instrument: group.instrument,
        side: "short",
        quantity: group.quantity,
        entryPrice: group.entryPrice,
        currentPrice: group.currentPrice,
        unrealizedPnl: group.unrealizedPnl,
        metadata: {
            structureType: "iron_condor",
            underlying: group.underlying,
            expiration: group.expiration,
            legs: group.positions.map((position) => ({
                symbol: position.symbol,
                side: position.side,
                qty: Math.abs(toNumber(position.qty)),
            })),
        },
    }
}

function mapSinglePosition(position: AlpacaPositionResponse): Position {
    const parsed = parseOptionContractSymbol(position.symbol)
    return {
        instrument: position.symbol,
        side: position.side,
        quantity: Math.abs(toNumber(position.qty)),
        entryPrice: toNumber(position.avg_entry_price),
        currentPrice: position.current_price ? toNumber(position.current_price) : undefined,
        unrealizedPnl: position.unrealized_pl ? toNumber(position.unrealized_pl) : undefined,
        metadata: parsed
            ? {
                underlying: parsed.underlying,
                expiration: parsed.expiration,
                optionType: parsed.optionType,
                strike: parsed.strike,
            }
            : undefined,
    }
}

function mapWorkingOrder(order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]): WorkingOrder {
    const submittedAt = resolveOrderTimestamp(order)
    const quantity = order.qty ? Number(order.qty) : 0
    const filledQuantity = Number(order.filled_qty ?? 0)

    return {
        orderId: order.id,
        instrument: resolveOrderInstrument(order),
        status: mapAlpacaOrderStatus(order.status),
        quantity,
        filledQuantity,
        remainingQuantity: Math.max(quantity - filledQuantity, 0),
        submittedAt,
        updatedAt: submittedAt,
        limitPrice: order.limit_price ? Number(order.limit_price) : undefined,
        stopPrice: order.stop_price ? Number(order.stop_price) : undefined,
        avgFillPrice: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        metadata: {
            legs: order.legs,
        },
    }
}

function resolveOrderInstrument(
    order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]
): string {
    if (!order.legs || order.legs.length === 0) {
        return order.id
    }

    const parsedLegs = order.legs
        .map((leg) => parseOptionContractSymbol(leg.symbol))
        .filter((value): value is NonNullable<ReturnType<typeof parseOptionContractSymbol>> => Boolean(value))

    if (parsedLegs.length === 4) {
        const underlying = parsedLegs[0]?.underlying
        const expiration = parsedLegs[0]?.expiration
        const sharedExpiration = parsedLegs.every((leg) => leg.expiration === expiration)

        if (underlying && expiration && sharedExpiration) {
            const quantity = order.qty ? Number(order.qty) : 1
            return buildIronCondorInstrument(underlying, expiration, quantity)
        }
    }

    return order.legs.map((leg) => leg.symbol).join(" | ")
}

function resolveGroupForClose(
    positions: AlpacaPositionResponse[],
    instrument: string
): PositionGroup | null {
    const grouped = groupIronCondorPositions(positions)
    const directMatch = grouped.find((group) => group.instrument === instrument)
    if (directMatch) {
        return directMatch
    }

    const byUnderlying = grouped.filter((group) => group.underlying === instrument.toUpperCase())
    if (byUnderlying.length === 1) {
        return byUnderlying[0] ?? null
    }

    return null
}

function toNumber(value: string | undefined): number {
    return value ? Number(value) : 0
}

function roundPrice(price: number): number {
    return Math.round(price * 100) / 100
}

function mapAlpacaOrderStatus(
    status: string
): ExecutionResult["status"] {
    switch (status) {
        case "filled":
            return "filled"
        case "partially_filled":
            return "partially_filled"
        case "canceled":
        case "cancelled":
        case "pending_cancel":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
        case "suspended":
            return "rejected"
        default:
            return "pending"
    }
}

function resolveOrderTimestamp(
    order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]
): number {
    const rawTimestamp = order.updated_at ?? order.submitted_at
    const parsed = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
}
