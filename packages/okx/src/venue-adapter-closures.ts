import type {
    Position,
    ProviderPositionClosure,
} from "@valiq-trading/core"
import type { OKXFill } from "./okx-client"
import {
    isOKXClosingFill,
    resolveOKXClosurePositionSide,
    sumOptionalNumberStrings,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

export async function mapOKXRecentPositionClosures(args: {
    fills: OKXFill[]
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
}): Promise<ProviderPositionClosure[]> {
    const grouped = groupClosingFills(args.fills)
    const closures: ProviderPositionClosure[] = []

    for (const group of grouped.values()) {
        const closure = await mapClosureGroup(group, args)
        if (closure) {
            closures.push(closure)
        }
    }

    return closures.sort((left, right) => right.closedAt - left.closedAt)
}

function groupClosingFills(fills: OKXFill[]): Map<string, OKXFill[]> {
    const grouped = new Map<string, OKXFill[]>()

    for (const fill of fills.filter(isOKXClosingFill)) {
        const key = `${fill.instId}:${fill.posSide ?? "net"}:${fill.ordId || fill.tradeId}:${resolveOKXClosurePositionSide(fill)}`
        const existing = grouped.get(key) ?? []
        existing.push(fill)
        grouped.set(key, existing)
    }

    return grouped
}

async function mapClosureGroup(
    group: OKXFill[],
    args: {
        getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
        contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
    }
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

    return {
        instrument: first.instId,
        side: resolveOKXClosurePositionSide(first) as Position["side"],
        quantity,
        fillPrice: weightedPrice,
        closedAt: Number.isFinite(closedAt) ? closedAt : Date.now(),
        metadata: {
            orderId: first.ordId,
            tradeIds: group.map((fill) => fill.tradeId).filter(Boolean),
            side: first.side,
            posSide: first.posSide,
            fillPnl: sumOptionalNumberStrings(group.map((fill) => fill.fillPnl)),
            fee: sumOptionalNumberStrings(group.map((fill) => fill.fee)),
            feeCcy: first.feeCcy,
            source: "okx_fills_history",
        },
    }
}
