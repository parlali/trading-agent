export const CASCADE_DELETE_COUNT_KEYS = [
    "runs",
    "agentLogs",
    "tradeEvents",
    "orders",
    "orderTransitions",
    "positions",
    "instrumentClaims",
    "positionSyncs",
    "strategyRiskStates",
    "executionSafetyFaults",
    "providerPositions",
    "providerWorkingOrders",
    "providerSyncStates",
    "accountSnapshots",
    "appHeartbeats",
    "manualRunRequests",
    "strategyMcpToolWhitelists",
    "alerts",
] as const

export type CascadeDeleteCountKey = typeof CASCADE_DELETE_COUNT_KEYS[number]
export type CascadeDeleteCounts = Record<CascadeDeleteCountKey, number>

export function createEmptyCascadeDeleteCounts(): CascadeDeleteCounts {
    return Object.fromEntries(
        CASCADE_DELETE_COUNT_KEYS.map((key) => [key, 0])
    ) as CascadeDeleteCounts
}
