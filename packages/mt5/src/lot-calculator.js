export function calculateLotSize(input) {
    const { accountBalance, maxRiskPercent, entryPrice, stopLossPrice, side, symbolInfo } = input;
    if (accountBalance <= 0) {
        return { error: "Account balance is zero or negative" };
    }
    if (symbolInfo.point <= 0 || symbolInfo.tickValue <= 0) {
        return { error: `Invalid symbol info: point=${symbolInfo.point}, tickValue=${symbolInfo.tickValue}` };
    }
    const slDistance = Math.abs(entryPrice - stopLossPrice);
    if (slDistance === 0) {
        return { error: "Stop-loss cannot equal entry price" };
    }
    if (side === "buy" && stopLossPrice >= entryPrice) {
        return { error: `Stop-loss ${stopLossPrice} must be below entry ${entryPrice} for buy orders` };
    }
    if (side === "sell" && stopLossPrice <= entryPrice) {
        return { error: `Stop-loss ${stopLossPrice} must be above entry ${entryPrice} for sell orders` };
    }
    const slDistancePoints = slDistance / symbolInfo.point;
    const riskPerLot = slDistancePoints * symbolInfo.tickValue;
    const maxRiskAmount = accountBalance * (maxRiskPercent / 100);
    const rawVolume = maxRiskAmount / riskPerLot;
    const volume = Math.floor(rawVolume / symbolInfo.volumeStep) * symbolInfo.volumeStep;
    const roundedVolume = Number(volume.toFixed(countDecimals(symbolInfo.volumeStep)));
    if (roundedVolume < symbolInfo.volumeMin) {
        const minRiskAmount = symbolInfo.volumeMin * riskPerLot;
        const minRiskPercent = (minRiskAmount / accountBalance) * 100;
        return {
            error: `Minimum lot ${symbolInfo.volumeMin} risks $${minRiskAmount.toFixed(2)} (${minRiskPercent.toFixed(1)}%), exceeding maxRiskPercent ${maxRiskPercent}%`,
        };
    }
    const clampedVolume = Math.min(roundedVolume, symbolInfo.volumeMax);
    const actualRiskAmount = clampedVolume * riskPerLot;
    const actualRiskPercent = (actualRiskAmount / accountBalance) * 100;
    return {
        volume: clampedVolume,
        riskAmount: actualRiskAmount,
        riskPercent: actualRiskPercent,
        slDistancePoints,
    };
}
export function computeTakeProfitFromRR(entryPrice, stopLossPrice, riskRewardRatio, side) {
    const slDistance = Math.abs(entryPrice - stopLossPrice);
    const tpDistance = slDistance * riskRewardRatio;
    if (side === "buy") {
        return entryPrice + tpDistance;
    }
    return entryPrice - tpDistance;
}
export function computeImpliedRR(entryPrice, stopLossPrice, takeProfitPrice, side) {
    const slDistance = Math.abs(entryPrice - stopLossPrice);
    if (slDistance === 0) {
        return { error: "Stop-loss cannot equal entry price" };
    }
    if (side === "buy" && takeProfitPrice <= entryPrice) {
        return { error: `Take-profit ${takeProfitPrice} must be above entry ${entryPrice} for buy orders` };
    }
    if (side === "sell" && takeProfitPrice >= entryPrice) {
        return { error: `Take-profit ${takeProfitPrice} must be below entry ${entryPrice} for sell orders` };
    }
    const tpDistance = Math.abs(takeProfitPrice - entryPrice);
    return tpDistance / slDistance;
}
function countDecimals(value) {
    const str = value.toString();
    const dotIndex = str.indexOf(".");
    if (dotIndex === -1)
        return 0;
    return str.length - dotIndex - 1;
}
