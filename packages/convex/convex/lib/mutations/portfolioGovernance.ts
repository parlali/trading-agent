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
        metadata?: string
    }>
    workingOrders: Array<{
        strategyId?: Id<"strategies">
        ownershipStatus: Doc<"provider_working_orders">["ownershipStatus"]
        expectedExternal?: boolean
        instrument: string
        action?: Doc<"orders">["action"]
        side?: "buy" | "sell"
        metadata?: string
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
                    instrumentsOverlap(strategy.app, order, position) &&
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
                        instrumentsOverlap(strategy.app, left, right)
                    ) {
                        const direction = left.side ?? "unknown"
                        violations.add(`${strategyId}:multiple-working-orders:${resolveGovernanceInstrument(left.instrument, right.instrument)}:${direction}`)
                    }
                }
            }
        }
    }

    const exposureByAlias = new Map<string, Map<string, string>>()
    for (const exposure of [
        ...ownedPositions.map((position) => ({
            strategyId: position.strategyId!,
            instrument: position.instrument,
            metadata: position.metadata,
        })),
        ...ownedWorkingOrders
            .filter(workingOrderCanOpenRisk)
            .map((order) => ({
                strategyId: order.strategyId!,
                instrument: order.instrument,
                metadata: order.metadata,
            })),
    ]) {
        const strategy = args.strategies.find((entry) => entry._id === exposure.strategyId)
        if (!strategy) {
            continue
        }

        for (const alias of getProviderInstrumentClaimAliases(strategy.app, exposure.instrument, exposure.metadata)) {
            const strategiesByInstrument = exposureByAlias.get(alias) ?? new Map<string, string>()
            strategiesByInstrument.set(String(exposure.strategyId), exposure.instrument)
            exposureByAlias.set(alias, strategiesByInstrument)
        }
    }

    for (const strategiesByInstrument of exposureByAlias.values()) {
        if (strategiesByInstrument.size <= 1) {
            continue
        }

        for (const [strategyId, instrument] of strategiesByInstrument) {
            violations.add(`${strategyId}:account-instrument-conflict:${instrument}`)
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
    left: { instrument: string; metadata?: string },
    right: { instrument: string; metadata?: string }
): boolean {
    const leftAliases = new Set(getProviderInstrumentClaimAliases(app, left.instrument, left.metadata))
    return getProviderInstrumentClaimAliases(app, right.instrument, right.metadata)
        .some((alias) => leftAliases.has(alias))
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
