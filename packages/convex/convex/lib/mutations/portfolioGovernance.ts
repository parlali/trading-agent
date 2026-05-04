import type { Doc, Id } from "../../_generated/dataModel"
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
        const policy = strategyPolicies.get(strategyId)
        if (!policy) {
            continue
        }

        const strategyPositions = ownedPositions.filter((position) => String(position.strategyId) === strategyId)
        const strategyWorkingOrders = ownedWorkingOrders.filter((order) => String(order.strategyId) === strategyId)

        if (!policy.allowOverlappingExposure) {
            for (const position of strategyPositions) {
                const sameInstrumentOrders = strategyWorkingOrders.filter((order) =>
                    order.instrument === position.instrument &&
                    workingOrderIncreasesExposure(order, position.side)
                )

                if (sameInstrumentOrders.length > 0) {
                    violations.add(`${strategyId}:overlap:${position.instrument}`)
                }
            }
        }

        if (!policy.allowMultiplePendingEntryOrdersPerInstrument) {
            const grouped = new Map<string, number>()
            for (const order of strategyWorkingOrders) {
                if (!workingOrderCanOpenRisk(order)) {
                    continue
                }

                const direction = order.side ?? "unknown"
                const key = `${order.instrument}:${direction}`
                grouped.set(key, (grouped.get(key) ?? 0) + 1)
            }

            for (const [key, count] of grouped) {
                if (count > 1) {
                    violations.add(`${strategyId}:multiple-working-orders:${key}`)
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
