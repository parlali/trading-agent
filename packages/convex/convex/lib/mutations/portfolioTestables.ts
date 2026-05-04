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
    resolveLiveWorkingOrderMatch,
} from "./portfolioOrders"
import { detectExposureGovernanceViolations } from "./portfolioGovernance"
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
    buildProviderCloseIntent,
    buildProviderProtectionIntent,
    inferClosedOrderStatus,
    readOrderCancelAt,
}
