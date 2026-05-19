import type { Doc, Id } from "../../_generated/dataModel"
import { getProviderInstrumentClaimAliases } from "../instrumentClaims"
import type { StrategyDoc } from "./portfolioTypes"

export function detectExposureGovernanceViolations(args: {
    strategies: StrategyDoc[]
    positions: Array<{
        strategyId?: Id<"strategies">
        ownershipStatus: Doc<"provider_positions">["ownershipStatus"]
        expectedExternal?: boolean
        instrument: string
        side: "long" | "short"
    }>
    workingOrders: Array<{
        strategyId?: Id<"strategies">
        ownershipStatus: Doc<"provider_working_orders">["ownershipStatus"]
        expectedExternal?: boolean
        instrument: string
        action?: Doc<"orders">["action"]
        side?: "buy" | "sell"
    }>
}): string[] {
    const strategyPolicies = new Map(
        args.strategies.map((strategy) => [String(strategy._id), readStrategyExposurePolicy(strategy)])
    )
    const violations = new Set<string>()

    const ownedPositions = args.positions.filter((position) =>
        position.strategyId !== undefined &&
        position.ownershipStatus === "owned" &&
        position.expectedExternal !== true
    )
    const ownedWorkingOrders = args.workingOrders.filter((order) =>
        order.strategyId !== undefined &&
        order.ownershipStatus === "owned" &&
        order.expectedExternal !== true
    )

    const strategyIds = new Set([
        ...ownedPositions.map((position) => String(position.strategyId)),
        ...ownedWorkingOrders.map((order) => String(order.strategyId)),
    ])

    for (const strategyId of strategyIds) {
        const strategy = args.strategies.find((entry) => String(entry._id) === strategyId)
        const policy = strategyPolicies.get(strategyId)
        if (!strategy || !policy) {
            continue
        }

        const strategyPositions = ownedPositions.filter((position) => String(position.strategyId) === strategyId)
        const strategyWorkingOrders = ownedWorkingOrders.filter((order) => String(order.strategyId) === strategyId)

        if (!policy.allowOverlappingExposure) {
            for (const position of strategyPositions) {
                const sameInstrumentOrders = strategyWorkingOrders.filter((order) =>
                    instrumentsOverlap(strategy.app, order.instrument, position.instrument) &&
                    workingOrderIncreasesExposure(order, position.side)
                )

                for (const order of sameInstrumentOrders) {
                    violations.add(`${strategyId}:overlap:${resolveGovernanceInstrument(order.instrument, position.instrument)}`)
                }
            }
        }

        if (!policy.allowMultiplePendingEntryOrdersPerInstrument) {
            const openingOrders = strategyWorkingOrders.filter(workingOrderCanOpenRisk)
            for (let leftIndex = 0; leftIndex < openingOrders.length; leftIndex++) {
                const left = openingOrders[leftIndex]
                if (!left) {
                    continue
                }

                for (const right of openingOrders.slice(leftIndex + 1)) {
                    if (
                        left.side === right.side &&
                        instrumentsOverlap(strategy.app, left.instrument, right.instrument)
                    ) {
                        const direction = left.side ?? "unknown"
                        violations.add(`${strategyId}:multiple-working-orders:${resolveGovernanceInstrument(left.instrument, right.instrument)}:${direction}`)
                    }
                }
            }
        }
    }

    return Array.from(violations).sort((left, right) => left.localeCompare(right))
}

function readStrategyExposurePolicy(strategy: StrategyDoc): {
    allowMultiplePendingEntryOrdersPerInstrument: boolean
    allowOverlappingExposure: boolean
} {
    const policy = strategy.policy && typeof strategy.policy === "object"
        ? strategy.policy as Record<string, unknown>
        : {}

    return {
        allowMultiplePendingEntryOrdersPerInstrument: policy.allowMultiplePendingEntryOrdersPerInstrument === true,
        allowOverlappingExposure: policy.allowOverlappingExposure === true,
    }
}

function workingOrderCanOpenRisk(order: {
    action?: Doc<"orders">["action"]
    side?: "buy" | "sell"
}): boolean {
    if (order.action === "close" || order.action === "cancel" || order.action === "modify") {
        return false
    }

    return order.side === "buy" || order.side === "sell"
}

function workingOrderIncreasesExposure(
    order: {
        action?: Doc<"orders">["action"]
        side?: "buy" | "sell"
    },
    positionSide: "long" | "short"
): boolean {
    if (!workingOrderCanOpenRisk(order)) {
        return false
    }

    return positionSide === "long"
        ? order.side === "buy"
        : order.side === "sell"
}

function instrumentsOverlap(
    app: Doc<"strategies">["app"],
    left: string,
    right: string
): boolean {
    const leftAliases = new Set(getProviderInstrumentClaimAliases(app, left))
    return getProviderInstrumentClaimAliases(app, right).some((alias) => leftAliases.has(alias))
}

function resolveGovernanceInstrument(left: string, right: string): string {
    if (left.includes(":")) {
        return left
    }

    if (right.includes(":")) {
        return right
    }

    return left
}
