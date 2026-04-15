export {
    createRun,
    recoverRunningRuns,
    recoverStaleRunningRuns,
    updateRun,
    recordRunCallback,
    logAgentMessage,
    logTradeEvent,
    upsertOrder,
    logOrderTransition,
} from "./lib/mutations/orders"

export {
    upsertStrategy,
    disableStrategy,
    deleteStrategy,
    deleteStrategyBatch,
    deleteOrphanedStrategyHistoryBatch,
    triggerManualRun,
    stopRun,
    deleteRun,
    deleteAllRuns,
    deleteAllStrategies,
    replaceAllStrategies,
} from "./lib/mutations/strategies"

export { syncPositions } from "./lib/mutations/positions"

export {
    createAlert,
    acknowledgeAlert,
    reportHeartbeat,
    reportHeartbeatLiveness,
    reportHeartbeatSnapshot,
    snapshotAccountState,
    setKillSwitch,
    claimManualRunRequests,
    ackManualRunRequest,
    clearManualRunRequest,
    clearFullResetState,
    clearFullResetStateBatch,
} from "./lib/mutations/system"

export {
    reconcileProviderPortfolio,
    recordProviderSyncFailure,
    adoptProviderPositions,
} from "./lib/mutations/portfolio"
