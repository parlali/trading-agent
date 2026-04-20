export interface CascadeDeleteCounts {
    runs: number
    agentLogs: number
    tradeEvents: number
    orders: number
    orderTransitions: number
    positions: number
    instrumentClaims: number
    positionSyncs: number
    strategyRiskStates: number
    executionSafetyFaults: number
    providerPositions: number
    providerWorkingOrders: number
    providerSyncStates: number
    accountSnapshots: number
    appHeartbeats: number
    manualRunRequests: number
    alerts: number
}

export function createEmptyCascadeDeleteCounts(): CascadeDeleteCounts {
    return {
        runs: 0,
        agentLogs: 0,
        tradeEvents: 0,
        orders: 0,
        orderTransitions: 0,
        positions: 0,
        instrumentClaims: 0,
        positionSyncs: 0,
        strategyRiskStates: 0,
        executionSafetyFaults: 0,
        providerPositions: 0,
        providerWorkingOrders: 0,
        providerSyncStates: 0,
        accountSnapshots: 0,
        appHeartbeats: 0,
        manualRunRequests: 0,
        alerts: 0,
    }
}
