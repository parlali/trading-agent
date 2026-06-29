import {
    buildProviderPositionKey,
    resolveProviderPositionId,
} from "../providerPositions"
import {
    hasPositionOwnershipMismatch,
    resolveOwnership,
} from "./portfolioOwnership"
import {
    buildProviderCloseIntent,
    buildProviderProtectionIntent,
    inferClosedOrderStatus,
    isRepairableTerminalWorkingOrder,
    resolveCanonicalProviderProtectionOrderId,
    resolveLiveWorkingOrderMatch,
} from "./portfolioOrders"
import { detectExposureGovernanceViolations } from "./portfolioGovernance"
import { resolveExecutionFaultWorkingOrder } from "./portfolioRows"
import {
    collectExpectedExternalInstruments,
    createDriftSummary,
    isExpectedExternalProviderRow,
    readOrderCancelAt,
} from "./portfolioUtils"

export const portfolioGovernanceTestables = {
    collectExpectedExternalInstruments,
    isExpectedExternalProviderRow,
    buildProviderPositionKey,
    createDriftSummary,
    detectExposureGovernanceViolations,
    hasPositionOwnershipMismatch,
    resolveProviderPositionId,
    resolveOwnership,
    resolveLiveWorkingOrderMatch,
    resolveCanonicalProviderProtectionOrderId,
    resolveExecutionFaultWorkingOrder,
    buildProviderCloseIntent,
    buildProviderProtectionIntent,
    inferClosedOrderStatus,
    isRepairableTerminalWorkingOrder,
    readOrderCancelAt,
}
