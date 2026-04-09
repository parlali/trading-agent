export const VENUE_APPS = ["alpaca-options", "polymarket", "mt5", "binance-futures"];
export const ACTIVE_VENUE_APPS = ["alpaca-options", "polymarket", "mt5"];
export const APPS = [...VENUE_APPS, "backend"];
export const SEVERITY_LEVELS = ["critical", "warning", "info"];
export const EVENT_TYPES = [
    "intent",
    "validation",
    "submission",
    "fill_update",
    "filled",
    "rejected",
    "cancelled",
];
export const ORDER_SIDES = ["buy", "sell"];
export const EXECUTION_ERROR_SOURCES = [
    "risk_engine",
    "pre_validation",
    "venue",
    "network",
    "timeout",
    "internal",
];
export const ORDER_LEG_SIDES = [
    "buy",
    "sell",
    "buy_to_open",
    "sell_to_open",
    "buy_to_close",
    "sell_to_close",
];
export const PROVIDER_OWNERSHIP_STATUSES = ["owned", "unowned", "orphaned"];
export const PORTFOLIO_PROVIDER_STATUSES = ["healthy", "degraded", "stale"];
