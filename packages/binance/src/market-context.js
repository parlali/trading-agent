export function createBinanceMarketContextLine(snapshots) {
    if (snapshots.length === 0) {
        return null;
    }
    const segments = [...snapshots]
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((snapshot) => {
        const spreadPct = `${snapshot.spreadPercent.toFixed(3)}%`;
        const funding = formatFundingRate(snapshot.fundingRate);
        return `${snapshot.instrument} mark ${snapshot.markPrice.toFixed(2)}, spread ${spreadPct}, funding ${funding}`;
    });
    return `Current crypto market context: ${segments.join(" | ")}`;
}
function formatFundingRate(rate) {
    const pct = rate * 100;
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(4)}%`;
}
