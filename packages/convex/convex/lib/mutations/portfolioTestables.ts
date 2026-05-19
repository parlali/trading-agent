import {
    buildProviderPositionKey,
    resolveProviderPositionId,
} from "../providerPositions"
import {
    buildAdoptedPositionClaims,
    buildPositionClaimsByKey,
    hasPositionOwnershipMismatch,
    resolveOwnership,
    resolvePositionOwnership,
} from "./portfolioOwnership"
import {
    buildProviderCloseIntent,
    buildProviderProtectionIntent,
    inferClosedOrderStatus,
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
    buildAdoptedPositionClaims,
    buildPositionClaimsByKey,
    buildProviderPositionKey,
    createDriftSummary,
    detectExposureGovernanceViolations,
    hasPositionOwnershipMismatch,
    resolveProviderPositionId,
    resolvePositionOwnership,
    resolveOwnership,
    resolveLiveWorkingOrderMatch,
    resolveCanonicalProviderProtectionOrderId,
    resolveExecutionFaultWorkingOrder,
    buildProviderCloseIntent,
    buildProviderProtectionIntent,
    inferClosedOrderStatus,
    readOrderCancelAt,
}
