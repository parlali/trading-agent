import { createExecutionError } from "@valiq-trading/core"
import type {
    OKXAccountBill,
    OKXAlgoOrder,
    OKXClient,
    OKXFill,
} from "./okx-client"

export async function getRecentOKXFills(
    client: OKXClient,
    begin: number
): Promise<OKXFill[]> {
    return await fetchBoundedOKXHistory<OKXFill>({
        label: "fills-history",
        code: "FILLS_HISTORY_TRUNCATED",
        begin,
        fetchPage: (after, limit) =>
            client.getFillsHistory("SWAP", { begin, limit, after }),
        getCursor: (fill) => fill.billId,
    })
}

export async function getRecentOKXAlgoOrders(
    client: OKXClient,
    begin: number
): Promise<OKXAlgoOrder[]> {
    const fetchOrdType = (ordType: "conditional" | "oco") =>
        fetchBoundedOKXHistory<OKXAlgoOrder>({
            label: `algo-order history (${ordType})`,
            code: "ALGO_HISTORY_TRUNCATED",
            begin,
            fetchPage: (after, limit) =>
                client.getAlgoOrdersHistory({ instType: "SWAP", ordType, begin, limit, after }),
            getCursor: (order) => order.algoId,
            isOlderThanBegin: (order) => {
                const createdAt = Number(order.cTime)
                return Number.isFinite(createdAt) && createdAt < begin
            },
        })
    const [conditional, oco] = await Promise.all([
        fetchOrdType("conditional"),
        fetchOrdType("oco"),
    ])
    return [...conditional, ...oco]
}

export async function getRecentOKXAccountBills(
    client: OKXClient,
    begin: number
): Promise<OKXAccountBill[]> {
    return await fetchBoundedOKXHistory<OKXAccountBill>({
        label: "account-bills history",
        code: "BILLS_HISTORY_TRUNCATED",
        begin,
        fetchPage: (after, limit) =>
            client.getAccountBills({ instType: "SWAP", begin, limit, after }),
        getCursor: (bill) => bill.billId,
        isOlderThanBegin: (bill) => {
            const occurredAt = Number(bill.ts)
            return Number.isFinite(occurredAt) && occurredAt < begin
        },
    })
}

async function fetchBoundedOKXHistory<T>(options: {
    label: string
    code: string
    begin: number
    fetchPage: (after: string | undefined, limit: number) => Promise<T[]>
    getCursor: (entry: T) => string | undefined
    isOlderThanBegin?: (entry: T) => boolean
}): Promise<T[]> {
    const pageSize = 100
    const maxPages = 10
    const entries: T[] = []
    let after: string | undefined

    for (let page = 0; page < maxPages; page++) {
        const batch = await options.fetchPage(after, pageSize)
        entries.push(...batch)

        if (batch.length < pageSize) {
            return entries
        }

        const oldest = batch[batch.length - 1]
        const cursor = oldest === undefined ? undefined : options.getCursor(oldest)
        if (oldest === undefined || !cursor) {
            throw createExecutionError("venue", `OKX ${options.label} returned a full page without a pagination cursor; refusing to treat a silently truncated window as complete`, {
                code: options.code,
                retryable: true,
                details: {
                    begin: options.begin,
                    pageSize,
                    page,
                    fetched: entries.length,
                    reason: "missing_pagination_cursor",
                },
            })
        }

        if (options.isOlderThanBegin?.(oldest)) {
            return entries
        }

        after = cursor
    }

    throw createExecutionError("venue", `OKX ${options.label} pagination exceeded the bounded page budget; refusing to reconcile from a truncated window`, {
        code: options.code,
        retryable: true,
        details: {
            begin: options.begin,
            pageSize,
            maxPages,
            fetched: entries.length,
            reason: "page_budget_exceeded",
        },
    })
}
