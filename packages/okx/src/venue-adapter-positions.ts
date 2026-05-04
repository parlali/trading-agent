import type { Position } from "@valiq-trading/core"
import type {
    OKXAlgoOrder,
    OKXApiPosSide,
    OKXPosition,
    OKXPositionMode,
} from "./okx-client"
import {
    isFiniteNumberString,
    resolvePositionSide,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

interface ProtectionLevelMap {
    stopLoss?: number
    takeProfit?: number
}

export async function mapOKXPositions(args: {
    positions: OKXPosition[]
    algoOrders: OKXAlgoOrder[]
    positionMode: OKXPositionMode
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
    resolvePositionPosSide: (side: Position["side"]) => OKXApiPosSide
    getProtectionKey: (instId: string, posSide: string | undefined) => string
}): Promise<Position[]> {
    const protectionByInstrument = new Map<string, ProtectionLevelMap>()

    for (const order of args.algoOrders) {
        const key = args.getProtectionKey(order.instId, order.posSide)
        const current = protectionByInstrument.get(key) ?? {}

        if (isFiniteNumberString(order.slTriggerPx) && current.stopLoss === undefined) {
            current.stopLoss = Number(order.slTriggerPx)
        }

        if (isFiniteNumberString(order.tpTriggerPx) && current.takeProfit === undefined) {
            current.takeProfit = Number(order.tpTriggerPx)
        }

        protectionByInstrument.set(key, current)
    }

    const normalized: Array<Position | null> = await Promise.all(
        args.positions.map(async (position) => {
            const contracts = Math.abs(Number(position.pos))
            if (!Number.isFinite(contracts) || contracts <= 0) {
                return null
            }

            const rules = await args.getInstrumentRules(position.instId)
            const side = resolvePositionSide(position, args.positionMode)
            const quantity = args.contractsToBaseQuantity(rules, contracts)
            const protectionKey = args.getProtectionKey(
                position.instId,
                args.resolvePositionPosSide(side)
            )
            const protection = protectionByInstrument.get(protectionKey)

            return {
                instrument: position.instId,
                providerPositionId: position.posId,
                side,
                quantity,
                entryPrice: Number(position.avgPx),
                currentPrice: Number(position.markPx),
                unrealizedPnl: Number(position.upl),
                stopLoss: protection?.stopLoss,
                takeProfit: protection?.takeProfit,
                metadata: {
                    contracts,
                    contractValue: rules.contractValue,
                    contractValueCurrency: rules.contractValueCurrency,
                    marginMode: position.mgnMode,
                    leverage: position.lever ? Number(position.lever) : undefined,
                    liquidationPrice: isFiniteNumberString(position.liqPx) ? Number(position.liqPx) : undefined,
                    positionMode: args.positionMode,
                    posId: position.posId,
                },
            } satisfies Position
        })
    )

    return normalized.filter((position): position is Position => position !== null)
}
