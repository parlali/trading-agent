import type {
    Position,
    ProviderPositionClosure,
} from "@valiq-trading/core"
import { createExecutionError } from "@valiq-trading/core"
import type { OKXAlgoOrder, OKXFill } from "./okx-client"
import {
    isFiniteNumberString,
    isOKXClosingFill,
    resolveOKXClosurePositionSide,
    sumOptionalNumberStrings,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

export async function mapOKXRecentPositionClosures(args: {
    fills: OKXFill[]
    algoOrders?: OKXAlgoOrder[]
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
}): Promise<ProviderPositionClosure[]> {
    const algoOrderByTriggeredOrderId = buildAlgoOrderByTriggeredOrderId(args.algoOrders ?? [])
    const grouped = groupClosingFills(args.fills, algoOrderByTriggeredOrderId)
    const closures: ProviderPositionClosure[] = []

    for (const group of grouped.values()) {
        const closure = await mapClosureGroup(group, args, algoOrderByTriggeredOrderId)
        if (closure) {
            closures.push(closure)
        }
    }

    return closures.sort((left, right) => right.closedAt - left.closedAt)
}

function buildAlgoOrderByTriggeredOrderId(algoOrders: OKXAlgoOrder[]): Map<string, OKXAlgoOrder> {
    const lookup = new Map<string, OKXAlgoOrder>()

    for (const order of algoOrders) {
        if (order.actualOrdId) {
            lookup.set(order.actualOrdId, order)
        }
    }

    return lookup
}

function groupClosingFills(
    fills: OKXFill[],
    algoOrderByTriggeredOrderId: Map<string, OKXAlgoOrder>
): Map<string, OKXFill[]> {
    const grouped = new Map<string, OKXFill[]>()

    for (const fill of fills.filter((entry) => isOKXClosingFill(entry) || hasTriggeredProtectionCloseEvidence(entry, algoOrderByTriggeredOrderId))) {
        const key = `${fill.instId}:${fill.posSide ?? "net"}:${fill.ordId || fill.tradeId}:${resolveOKXClosurePositionSide(fill)}`
        const existing = grouped.get(key) ?? []
        existing.push(fill)
        grouped.set(key, existing)
    }

    return grouped
}

function hasTriggeredProtectionCloseEvidence(
    fill: OKXFill,
    algoOrderByTriggeredOrderId: Map<string, OKXAlgoOrder>
): boolean {
    if (
        !isFiniteNumberString(fill.fillSz) ||
        Number(fill.fillSz) <= 0 ||
        !isFiniteNumberString(fill.fillPx) ||
        !isFiniteNumberString(fill.ts)
    ) {
        return false
    }

    const order = fill.ordId ? algoOrderByTriggeredOrderId.get(fill.ordId) : undefined
    return order !== undefined &&
        order.instId === fill.instId &&
        order.side === fill.side
}

async function mapClosureGroup(
    group: OKXFill[],
    args: {
        getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
        contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
    },
    algoOrderByTriggeredOrderId: Map<string, OKXAlgoOrder>
): Promise<ProviderPositionClosure | null> {
    const first = group[0]
    if (!first) {
        return null
    }

    const rules = await args.getInstrumentRules(first.instId)
    const contracts = group.reduce((sum, fill) => sum + Math.abs(Number(fill.fillSz)), 0)
    const quantity = args.contractsToBaseQuantity(rules, contracts)
    if (!Number.isFinite(quantity) || quantity <= 0 || contracts <= 0) {
        return null
    }

    const weightedPrice = group.reduce((sum, fill) => {
        const size = Math.abs(Number(fill.fillSz))
        return sum + size * Number(fill.fillPx)
    }, 0) / contracts
    const closedAt = Math.max(...group.map((fill) => Number(fill.ts)).filter(Number.isFinite))
    const feeCcy = resolveClosureFeeCurrency(group)
    const providerPositionId = resolveClosureProviderPositionId(group)
    const algoOrder = first.ordId ? algoOrderByTriggeredOrderId.get(first.ordId) : undefined
    const algoMetadata = algoOrder
        ? {
            triggeredOrderId: first.ordId,
            algoId: algoOrder.algoId,
            algoClOrdId: algoOrder.algoClOrdId,
            actualOrdId: algoOrder.actualOrdId,
            providerOrderAliases: [
                first.ordId,
                first.clOrdId,
                algoOrder.algoId,
                algoOrder.algoClOrdId,
                algoOrder.actualOrdId,
            ].filter((value): value is string => Boolean(value)),
        }
        : {}

    return {
        instrument: first.instId,
        providerPositionId,
        side: resolveOKXClosurePositionSide(first) as Position["side"],
        quantity,
        fillPrice: weightedPrice,
        closedAt: Number.isFinite(closedAt) ? closedAt : Date.now(),
        metadata: {
            orderId: first.ordId,
            clientOrderId: first.clOrdId || undefined,
            providerPositionId,
            providerPositionKey: providerPositionId ? `${first.instId}:${providerPositionId}` : undefined,
            ...algoMetadata,
            tradeIds: group.map((fill) => fill.tradeId).filter(Boolean),
            side: first.side,
            posSide: first.posSide,
            subType: first.subType,
            posId: providerPositionId,
            fillPnl: sumOptionalNumberStrings(group.map((fill) => fill.fillPnl)),
            fee: sumOptionalNumberStrings(group.map((fill) => fill.fee)),
            feeCcy,
            source: "okx_fills_history",
        },
    }
}

function resolveClosureProviderPositionId(group: OKXFill[]): string | undefined {
    const providerPositionIds = new Set<string>()

    for (const fill of group) {
        const posId = fill.posId?.trim()
        if (posId) {
            providerPositionIds.add(posId)
        }
    }

    if (providerPositionIds.size === 0) {
        return undefined
    }

    if (providerPositionIds.size > 1) {
        const first = group[0]
        throw createExecutionError("venue", `OKX close fill group ${first?.ordId ?? "unknown"} has mixed provider position ids: ${Array.from(providerPositionIds).join(", ")}`, {
            code: "OKX_CLOSE_POSITION_ID_MIXED",
            retryable: false,
            details: {
                instId: first?.instId,
                ordId: first?.ordId,
                tradeIds: group.map((fill) => fill.tradeId).filter(Boolean),
                providerPositionIds: Array.from(providerPositionIds).sort((left, right) => left.localeCompare(right)),
            },
        })
    }

    return providerPositionIds.values().next().value
}

function resolveClosureFeeCurrency(group: OKXFill[]): string | undefined {
    const feeCurrencies = new Set<string>()

    for (const fill of group) {
        const hasNonZeroFee = isFiniteNumberString(fill.fee) && Number(fill.fee) !== 0
        if (!hasNonZeroFee) {
            continue
        }

        const feeCcy = fill.feeCcy?.trim().toUpperCase()
        if (!feeCcy) {
            throw createExecutionError("venue", `OKX close fill ${fill.tradeId} has a nonzero fee without feeCcy`, {
                code: "OKX_CLOSE_FEE_CURRENCY_MISSING",
                retryable: false,
                details: {
                    instId: fill.instId,
                    ordId: fill.ordId,
                    tradeId: fill.tradeId,
                    fee: fill.fee,
                },
            })
        }

        feeCurrencies.add(feeCcy)
    }

    if (feeCurrencies.size > 1) {
        const first = group[0]
        throw createExecutionError("venue", `OKX close fill group ${first?.ordId ?? "unknown"} has mixed fee currencies: ${Array.from(feeCurrencies).join(", ")}`, {
            code: "OKX_CLOSE_FEE_CURRENCY_MIXED",
            retryable: false,
            details: {
                instId: first?.instId,
                ordId: first?.ordId,
                tradeIds: group.map((fill) => fill.tradeId).filter(Boolean),
                feeCurrencies: Array.from(feeCurrencies).sort((left, right) => left.localeCompare(right)),
            },
        })
    }

    return feeCurrencies.values().next().value
}
