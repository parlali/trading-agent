import {
    DEFAULT_APP_KILL_SWITCHES,
    toVenueKillSwitchKey,
    type AppKillSwitches,
    type VenueApp,
} from "@valiq-trading/core"

export type KillSwitchScope = VenueApp | "global"

export function createDefaultAppKillSwitches(overrides: Partial<AppKillSwitches> = {}): AppKillSwitches {
    return {
        ...DEFAULT_APP_KILL_SWITCHES,
        ...overrides,
    }
}

export function createDefaultKillSwitchState(scope?: KillSwitchScope, enabled = false) {
    const appKillSwitches = createDefaultAppKillSwitches()
    if (scope && scope !== "global") {
        appKillSwitches[toVenueKillSwitchKey(scope)] = enabled
    }

    return {
        key: "kill_switches" as const,
        globalKillSwitch: scope === "global" ? enabled : false,
        appKillSwitches,
        updatedAt: 0,
    }
}

export function toKillSwitchKey(scope: VenueApp) {
    return toVenueKillSwitchKey(scope)
}
