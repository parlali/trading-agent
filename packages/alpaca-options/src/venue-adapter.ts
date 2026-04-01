import type { AccountState, ExecutionResult, OrderIntent, Position, VenueAdapter } from "@valiq-trading/core"
import { AlpacaClient, type AlpacaPositionResponse } from "./alpaca-client"
import { parseOptionContractSymbol } from "./risk-rules"

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
        const balance = toNumber(account.equity) || toNumber(account.portfolio_value)
        const previousBalance = toNumber(account.last_equity)
        const openPnl = toNumber(account.unrealized_pl)

        return {
            balance,
            buyingPower: toNumber(account.buying_power) || toNumber(account.regt_buying_power),
            marginUsed: toNumber(account.initial_margin) || toNumber(account.maintenance_margin),
            marginAvailable: Math.max((toNumber(account.buying_power) || 0) - (toNumber(account.initial_margin) || 0), 0),
            openPnl,
            dayPnl: previousBalance > 0 ? balance - previousBalance : 0,
        }
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

    async closePosition(instrument: string): Promise<ExecutionResult> {
        const rawPositions = await this.client.getPositions()
        const group = resolveGroupForClose(rawPositions, instrument)

        if (!group) {
            throw new Error(`No Alpaca options structure found for ${instrument}`)
        }

        const closeIntent: OrderIntent = {
            instrument: group.instrument,
            side: "buy",
            quantity: group.quantity,
            orderType: group.currentPrice ? "limit" : "market",
            limitPrice: group.currentPrice ? roundPrice(group.currentPrice) : undefined,
            timeInForce: "day",
            legs: group.positions.map((position) => ({
                instrument: position.symbol,
                side: position.side === "long" ? "sell" : "buy",
                quantity: Math.abs(toNumber(position.qty)),
            })),
            metadata: {
                action: "close",
                underlying: group.underlying,
                expiration: group.expiration,
            },
        }

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
            instrument: `IC:${underlying}:${expiration}:${quantity}`,
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
