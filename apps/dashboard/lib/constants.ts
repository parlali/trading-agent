import {
    TrendingUp,
    Coins,
    BarChart3,
} from "lucide-react"
import type { VenueApp, ActiveVenueApp, Severity } from "@valiq-trading/core"
import { VENUE_APPS, ACTIVE_VENUE_APPS } from "@valiq-trading/core"

export type { VenueApp, ActiveVenueApp } from "@valiq-trading/core"
export { VENUE_APPS, ACTIVE_VENUE_APPS } from "@valiq-trading/core"

type VenueMeta = {
    label: string
    shortLabel: string
    description: string
    icon: typeof TrendingUp
    color: string
    chartColor: string
}

export const VENUE_META: Record<ActiveVenueApp, VenueMeta> = {
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
    "okx-swap": {
        label: "OKX",
        shortLabel: "OKX",
        description: "Perpetual swaps",
        icon: TrendingUp,
        color: "var(--chart-4)",
        chartColor: "hsl(12, 65%, 52%)",
    },
} as const

export const STALE_THRESHOLD_MS = 2 * 60 * 1000

export const STATUS_COLORS = {
    healthy: "text-signal-healthy",
    degraded: "text-signal-warning",
    unhealthy: "text-signal-danger",
    running: "text-signal-warning",
    completed: "text-signal-healthy",
    failed: "text-signal-danger",
} as const

export const SEVERITY_COLORS: Record<Severity, string> = {
    critical: "text-signal-danger bg-signal-danger/10",
    warning: "text-signal-warning bg-signal-warning/10",
    info: "text-muted-foreground bg-muted",
} as const
