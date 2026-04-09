const DEFAULT_INSTRUMENT_PROFILES = {
    EURUSD: {
        regions: ["US", "GB", "EU"],
        normalSpreadPips: 1.0,
    },
    USDJPY: {
        regions: ["US", "GB", "EU"],
        normalSpreadPips: 1.0,
    },
    XAUUSD: {
        regions: ["US", "GB"],
        normalSpreadPips: 25,
    },
    US30: {
        regions: ["US"],
        normalSpreadPips: 20,
    },
};
const DEFAULT_STRATEGY_INSTRUMENTS = {
    "00:00|22:00|UTC": ["EURUSD", "USDJPY"],
    "07:00|21:00|UTC": ["XAUUSD"],
    "13:00|21:00|UTC": ["US30"],
};
export function resolveMT5InstrumentRegions(policy) {
    const configured = normalizeConfiguredInstrumentRegions(policy.marketRegionsByInstrument);
    if (Object.keys(configured).length > 0) {
        return configured;
    }
    const fallbackInstruments = resolveFallbackInstruments(policy);
    const fallbackRegions = fallbackInstruments.flatMap((instrument) => {
        const profile = DEFAULT_INSTRUMENT_PROFILES[instrument];
        if (!profile) {
            return [];
        }
        return [[instrument, profile.regions]];
    });
    return Object.fromEntries(fallbackRegions);
}
export function createMT5SpreadContextLine(snapshots) {
    if (snapshots.length === 0) {
        return null;
    }
    const parts = [...snapshots]
        .sort((left, right) => left.instrument.localeCompare(right.instrument))
        .map((snapshot) => {
        const normalSpread = getNormalSpreadPips(snapshot.instrument);
        const currentSpread = formatSpreadPips(snapshot.spreadPips);
        if (normalSpread === undefined) {
            return `${snapshot.instrument} ${currentSpread} pips`;
        }
        return `${snapshot.instrument} ${currentSpread} pips (normal ~${formatSpreadPips(normalSpread)})`;
    });
    return `Current spreads: ${parts.join(", ")}`;
}
export function toMT5MarketSnapshot(symbolInfo) {
    return {
        instrument: normalizeInstrument(symbolInfo.symbol),
        bid: symbolInfo.bid,
        ask: symbolInfo.ask,
        spreadPips: resolveSpreadPips(symbolInfo),
    };
}
function normalizeConfiguredInstrumentRegions(configured) {
    if (!configured) {
        return {};
    }
    const entries = Object.entries(configured).flatMap(([instrument, regions]) => {
        const normalizedInstrument = normalizeInstrument(instrument);
        const normalizedRegions = [...new Set(regions
                .map((region) => region.trim().toUpperCase())
                .filter((region) => region.length > 0))];
        if (!normalizedInstrument || normalizedRegions.length === 0) {
            return [];
        }
        return [[normalizedInstrument, normalizedRegions]];
    });
    return Object.fromEntries(entries);
}
function resolveFallbackInstruments(policy) {
    const key = [
        policy.tradingHours.start,
        policy.tradingHours.end,
        policy.tradingHours.timezone.toUpperCase(),
    ].join("|");
    return DEFAULT_STRATEGY_INSTRUMENTS[key] ?? [];
}
function getNormalSpreadPips(instrument) {
    return DEFAULT_INSTRUMENT_PROFILES[normalizeInstrument(instrument)]?.normalSpreadPips;
}
function normalizeInstrument(instrument) {
    return instrument.trim().toUpperCase();
}
function resolveSpreadPips(symbolInfo) {
    const priceSpread = Math.abs(symbolInfo.ask - symbolInfo.bid);
    if (symbolInfo.pipSize > 0 && priceSpread > 0) {
        return priceSpread / symbolInfo.pipSize;
    }
    if (symbolInfo.point > 0 && symbolInfo.pipSize > 0 && symbolInfo.spread > 0) {
        return (symbolInfo.spread * symbolInfo.point) / symbolInfo.pipSize;
    }
    return symbolInfo.spread;
}
function formatSpreadPips(value) {
    if (Math.abs(value) < 10) {
        return value.toFixed(1);
    }
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}
