export const VENUE_APPS = ["alpaca-options", "polymarket", "mt5", "okx-swap"] as const
export const ACTIVE_VENUE_APPS = ["alpaca-options", "polymarket", "mt5", "okx-swap"] as const
export type ActiveVenueApp = typeof ACTIVE_VENUE_APPS[number]
export type VenueApp = typeof VENUE_APPS[number]

export const APPS = [...VENUE_APPS, "backend"] as const
export type App = typeof APPS[number]

export const VENUE_KILL_SWITCH_KEYS = {
    "alpaca-options": "alpaca_options",
    "polymarket": "polymarket",
    "mt5": "mt5",
    "okx-swap": "okx_swap",
} as const satisfies Record<VenueApp, string>

export type VenueKillSwitchKey = typeof VENUE_KILL_SWITCH_KEYS[VenueApp]
export type AppKillSwitches = Record<VenueKillSwitchKey, boolean>

export const DEFAULT_APP_KILL_SWITCHES: AppKillSwitches = {
    alpaca_options: false,
    polymarket: false,
    mt5: false,
    okx_swap: false,
}

export function toVenueKillSwitchKey(app: VenueApp): VenueKillSwitchKey {
    return VENUE_KILL_SWITCH_KEYS[app]
}
