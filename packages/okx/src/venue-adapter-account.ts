import type { AccountState } from "@valiq-trading/core"
import type {
    OKXAccountBalance,
    OKXPosition,
} from "./okx-client"
import {
    firstDefinedNumber,
    readFiniteNumberString,
    type OKXInstrumentRules,
} from "./venue-adapter-utils"

const OKX_SETTLEMENT_CURRENCY = "USDT"

export async function mapOKXAccountState(args: {
    balance: OKXAccountBalance
    positions: OKXPosition[]
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
}): Promise<AccountState> {
    const settlementBalance = resolveSettlementBalanceDetail(args.balance)
    const equity = firstDefinedNumber(
        settlementBalance?.eq,
        args.balance.totalEq
    ) ?? 0
    const positionOpenPnl = args.positions.reduce((sum, position) =>
        sum + (readFiniteNumberString(position.upl) ?? 0), 0)
    const accountOpenPnl = readFiniteNumberString(args.balance.upl)
    const openPnl = accountOpenPnl !== undefined && accountOpenPnl !== 0
        ? accountOpenPnl
        : positionOpenPnl
    const accountMarginUsed = firstDefinedNumber(args.balance.imr, args.balance.mmr)
    const positionMarginUsed = await resolvePositionMarginUsed(args)
    const marginUsed = accountMarginUsed !== undefined && accountMarginUsed !== 0
        ? accountMarginUsed
        : positionMarginUsed
    const available = firstDefinedNumber(
        settlementBalance?.availEq,
        settlementBalance?.availBal,
        settlementBalance?.cashBal,
        args.balance.availEq,
        args.balance.adjEq,
        args.balance.details[0]?.availEq,
        args.balance.details[0]?.availBal,
        args.balance.details[0]?.cashBal
    ) ?? Math.max(equity - marginUsed, 0)

    return {
        balance: Math.max(equity - openPnl, 0),
        equity,
        buyingPower: available,
        marginUsed,
        marginAvailable: available,
        openPnl,
        dayPnl: 0,
    }
}

function resolveSettlementBalanceDetail(
    balance: OKXAccountBalance
): OKXAccountBalance["details"][number] | undefined {
    return balance.details.find((detail) =>
        detail.ccy.trim().toUpperCase() === OKX_SETTLEMENT_CURRENCY
    )
}

async function resolvePositionMarginUsed(args: {
    positions: OKXPosition[]
    getInstrumentRules: (instId: string) => Promise<OKXInstrumentRules>
    contractsToBaseQuantity: (rules: OKXInstrumentRules, contracts: number) => number
}): Promise<number> {
    let total = 0

    for (const position of args.positions) {
        const providerMargin = firstDefinedNumber(position.imr, position.margin, position.mmr)
        if (providerMargin !== undefined) {
            total += providerMargin
            continue
        }

        const contracts = Math.abs(readFiniteNumberString(position.pos) ?? 0)
        const markPrice = readFiniteNumberString(position.markPx) ?? 0
        const leverage = readFiniteNumberString(position.lever)
        if (contracts <= 0 || markPrice <= 0 || leverage === undefined || leverage <= 0) {
            continue
        }

        const rules = await args.getInstrumentRules(position.instId)
        total += args.contractsToBaseQuantity(rules, contracts) * markPrice / leverage
    }

    return total
}
