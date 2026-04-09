import { TrendingUp, Coins, BarChart3, } from "lucide-react";
export { VENUE_APPS, ACTIVE_VENUE_APPS } from "@valiq-trading/core";
export const VENUE_META = {
    "alpaca-options": {
        label: "Alpaca Options",
        shortLabel: "Alpaca",
        description: "Options iron condors and complex spreads",
        icon: TrendingUp,
        color: "var(--chart-1)",
        chartColor: "hsl(162, 60%, 40%)",
    },
    polymarket: {
        label: "Polymarket",
        shortLabel: "Polymarket",
        description: "Prediction market positions",
        icon: Coins,
        color: "var(--chart-2)",
        chartColor: "hsl(230, 50%, 55%)",
    },
    mt5: {
        label: "MT5",
        shortLabel: "MT5",
        description: "Intraday FX and indices",
        icon: BarChart3,
        color: "var(--chart-3)",
        chartColor: "hsl(45, 60%, 55%)",
    },
};
export const STALE_THRESHOLD_MS = 2 * 60 * 1000;
export const STATUS_COLORS = {
    healthy: "text-signal-healthy",
    degraded: "text-signal-warning",
    unhealthy: "text-signal-danger",
    running: "text-signal-warning",
    completed: "text-signal-healthy",
    failed: "text-signal-danger",
};
export const SEVERITY_COLORS = {
    critical: "text-signal-danger bg-signal-danger/10",
    warning: "text-signal-warning bg-signal-warning/10",
    info: "text-muted-foreground bg-muted",
};
