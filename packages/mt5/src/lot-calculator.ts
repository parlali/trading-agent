import type { MT5SymbolInfo } from "./mt5-client"

export interface LotSizeInput {
    accountBalance: number
    maxRiskPercent: number
    entryPrice: number
    stopLossPrice: number
    side: "buy" | "sell"
    symbolInfo: MT5SymbolInfo
}

export interface LotSizeResult {
    volume: number
    riskAmount: number
    riskPercent: number
    slDistancePoints: number
}

type PriceDirection = "above" | "below"

export function calculateLotSize(input: LotSizeInput): LotSizeResult | { error: string } {
    const { accountBalance, maxRiskPercent, entryPrice, stopLossPrice, side, symbolInfo } = input

    if (accountBalance <= 0) {
        return { error: "Account balance is zero or negative" }
    }

    if (symbolInfo.point <= 0 || symbolInfo.tickValue <= 0) {
        return { error: `Invalid symbol info: point=${symbolInfo.point}, tickValue=${symbolInfo.tickValue}` }
    }

    const slDistance = resolveStopLossDistance(entryPrice, stopLossPrice)
    if (typeof slDistance !== "number") return slDistance

    const stopLossDirectionError = validatePriceDirection(
        side,
        stopLossPrice,
        entryPrice,
        "Stop-loss",
        { buy: "below", sell: "above" }
    )
    if (stopLossDirectionError) return stopLossDirectionError

    const slDistancePoints = slDistance / symbolInfo.point
    const riskPerLot = slDistancePoints * symbolInfo.tickValue
    const maxRiskAmount = accountBalance * (maxRiskPercent / 100)
    const rawVolume = maxRiskAmount / riskPerLot

    const volume = Math.floor(rawVolume / symbolInfo.volumeStep) * symbolInfo.volumeStep
    const roundedVolume = Number(volume.toFixed(countDecimals(symbolInfo.volumeStep)))

    if (roundedVolume < symbolInfo.volumeMin) {
        const minRiskAmount = symbolInfo.volumeMin * riskPerLot
        const minRiskPercent = (minRiskAmount / accountBalance) * 100
        return {
            error: `Minimum lot ${symbolInfo.volumeMin} risks $${minRiskAmount.toFixed(2)} (${minRiskPercent.toFixed(1)}%), exceeding maxRiskPercent ${maxRiskPercent}%`,
        }
    }

    const clampedVolume = Math.min(roundedVolume, symbolInfo.volumeMax)
    const actualRiskAmount = clampedVolume * riskPerLot
    const actualRiskPercent = (actualRiskAmount / accountBalance) * 100

    return {
        volume: clampedVolume,
        riskAmount: actualRiskAmount,
        riskPercent: actualRiskPercent,
        slDistancePoints,
    }
}

export function computeTakeProfitFromRR(
    entryPrice: number,
    stopLossPrice: number,
    riskRewardRatio: number,
    side: "buy" | "sell"
): number {
    const slDistance = Math.abs(entryPrice - stopLossPrice)
    const tpDistance = slDistance * riskRewardRatio

    if (side === "buy") {
        return entryPrice + tpDistance
    }
    return entryPrice - tpDistance
}

export function computeImpliedRR(
    entryPrice: number,
    stopLossPrice: number,
    takeProfitPrice: number,
    side: "buy" | "sell"
): number | { error: string } {
    const slDistance = resolveStopLossDistance(entryPrice, stopLossPrice)
    if (typeof slDistance !== "number") return slDistance

    const takeProfitDirectionError = validatePriceDirection(
        side,
        takeProfitPrice,
        entryPrice,
        "Take-profit",
        { buy: "above", sell: "below" }
    )
    if (takeProfitDirectionError) return takeProfitDirectionError

    const tpDistance = Math.abs(takeProfitPrice - entryPrice)
    return tpDistance / slDistance
}

function validatePriceDirection(
    side: "buy" | "sell",
    price: number,
    entryPrice: number,
    label: string,
    expected: Record<"buy" | "sell", PriceDirection>
): { error: string } | undefined {
    const direction = expected[side]
    const valid = direction === "above"
        ? price > entryPrice
        : price < entryPrice

    if (valid) {
        return undefined
    }

    return {
        error: `${label} ${price} must be ${direction} entry ${entryPrice} for ${side} orders`,
    }
}

function resolveStopLossDistance(
    entryPrice: number,
    stopLossPrice: number
): number | { error: string } {
    const distance = Math.abs(entryPrice - stopLossPrice)
    if (distance === 0) {
        return { error: "Stop-loss cannot equal entry price" }
    }

    return distance
}

function countDecimals(value: number): number {
    const str = value.toString()
    const dotIndex = str.indexOf(".")
    if (dotIndex === -1) return 0
    return str.length - dotIndex - 1
}
