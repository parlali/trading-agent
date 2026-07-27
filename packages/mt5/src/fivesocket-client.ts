import { createHash } from "node:crypto"
import {
    createExecutionError,
    fetchWithTimeout,
    getErrorMessage,
    getExecutionErrorDetail,
    OperationTimeoutError,
    withTimeout,
} from "@valiq-trading/core"
import {
    MT5Client,
    type MT5AccountInfo,
    type MT5AccountPnlEvent,
    type MT5OpenOrder,
    type MT5OrderResult,
    type MT5Position,
    type MT5PositionClosure,
    type MT5SymbolInfo,
    type MT5AccountCredentials,
    type MT5AccountStateSnapshot,
} from "./mt5-client"
import {
    fromDecimalString,
    fromSafeIntegerString,
    toPriceDecimalString,
    toUnsignedIntString,
    toVolumeDecimalString,
} from "./fivesocket-decimals"
import {
    mapFiveSocketAccountPnlEvents,
    mapFiveSocketBalanceToAccountInfo,
    mapFiveSocketExecutionCommand,
    mapFiveSocketExecutionSymbol,
    mapFiveSocketPosition,
    mapFiveSocketPositionClosures,
    mapFiveSocketReadiness,
    mapFiveSocketWorkingOrder,
    type FiveSocketApiReadiness,
    type FiveSocketBalance,
    type FiveSocketDeal,
    type FiveSocketExecutionCommand,
    type FiveSocketExecutionSymbol,
    type FiveSocketPosition,
    type FiveSocketWorkingOrder,
} from "./fivesocket-mappers"

export interface FiveSocketExecutionSymbolPolicy {
    symbol: string
    maxVolume: string
}

export interface FiveSocketClientConfig {
    baseUrl: string
    apiKey: string
    timeout?: number
    connectTimeout?: number
    fetchImpl?: typeof fetch
    executionSymbols?: readonly FiveSocketExecutionSymbolPolicy[]
    commandPollAttempts?: number
    commandPollDelayMs?: number
    maxDealPages?: number
    minRequestIntervalMs?: number
}

type FiveSocketApiErrorBody = {
    retryAfter?: unknown
    error?: {
        code?: string
        message?: string
        requestId?: string
        retryAfter?: unknown
    }
}

type FiveSocketApiError = {
    code?: string
    message?: string
    requestId?: string
    retryAfterMs?: number
}

const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250
const DEAL_WATERMARK_OVERLAP_MS = 15 * 60 * 1000

type LinkedAccount = {
    id: string
    login: string
    server: string
    status: string
}

type AccountLinkState = {
    promise: Promise<string>
}

export class FiveSocketClient extends MT5Client {
    private readonly fsBaseUrl: string
    private readonly apiKey: string
    private readonly fsTimeout: number
    private readonly fsConnectTimeout: number
    private readonly fsFetchImpl: typeof fetch
    private executionSymbols: readonly FiveSocketExecutionSymbolPolicy[]
    private executionSymbolsKey: string
    private readonly commandPollAttempts: number
    private readonly commandPollDelayMs: number
    private readonly maxDealPages: number
    private readonly minRequestIntervalMs: number
    private readonly accountIdByKey = new Map<string, string>()
    private readonly accountLinkStateByKey = new Map<string, AccountLinkState>()
    private readonly dealWatermarkByAccountId = new Map<string, number>()
    private readonly configuredExecutionPolicyKeyByAccountId = new Map<string, string>()
    private readonly executionPolicyQueueByAccountId = new Map<string, Promise<void>>()
    private pacingQueue: Promise<void> = Promise.resolve()
    private nextPacedRequestStartAt = 0
    private cachedLogin: number | null = null

    constructor(config: FiveSocketClientConfig) {
        super()
        this.fsBaseUrl = config.baseUrl.replace(/\/$/, "")
        this.apiKey = config.apiKey
        this.fsTimeout = config.timeout ?? 150_000
        this.fsConnectTimeout = config.connectTimeout ?? Math.max(this.fsTimeout, 150_000)
        this.fsFetchImpl = config.fetchImpl ?? fetch
        this.executionSymbols = normalizeExecutionSymbols(config.executionSymbols ?? [])
        this.executionSymbolsKey = executionPolicyKey(this.executionSymbols)
        this.commandPollAttempts = config.commandPollAttempts ?? 3
        this.commandPollDelayMs = config.commandPollDelayMs ?? 250
        this.maxDealPages = config.maxDealPages ?? 10_000
        this.minRequestIntervalMs = normalizeMinRequestIntervalMs(config.minRequestIntervalMs)
    }

    updateExecutionSymbols(symbols: readonly FiveSocketExecutionSymbolPolicy[]): boolean {
        const normalized = normalizeExecutionSymbols(symbols)
        const nextKey = executionPolicyKey(normalized)
        if (nextKey === this.executionSymbolsKey) {
            return false
        }

        this.executionSymbols = normalized
        this.executionSymbolsKey = nextKey
        return true
    }

    override async connect(credentials: MT5AccountCredentials): Promise<MT5AccountInfo> {
        const budget = createTimeoutBudget(this.fsConnectTimeout)
        await this.ensureAccount(credentials, budget)
        return await this.readAccountInfo(credentials, budget)
    }

    override async disconnect(): Promise<void> {
    }

    override async getHealth(options: { timeout?: number } = {}): Promise<{ status: string; connected: boolean; login: number | null }> {
        const readiness = await this.requestJson<FiveSocketApiReadiness>(
            "GET",
            "/ready",
            {
                timeout: options.timeout ?? this.fsTimeout,
                retry: true,
                auth: false,
            }
        )
        return mapFiveSocketReadiness(readiness, this.cachedLogin)
    }

    override async getAccount(credentials: MT5AccountCredentials): Promise<MT5AccountInfo> {
        return await this.readAccountInfo(credentials)
    }

    private async readAccountInfo(
        credentials: MT5AccountCredentials,
        budget?: TimeoutBudget
    ): Promise<MT5AccountInfo> {
        const accountId = await this.ensureAccount(credentials, budget)
        const balance = await this.requestJson<FiveSocketBalance>(
            "GET",
            `/v1/accounts/${encodeURIComponent(accountId)}/balance`,
            {
                ...(budget ? { budget } : { timeout: this.fsTimeout }),
                retry: true,
            }
        )
        const info = mapFiveSocketBalanceToAccountInfo(balance)
        this.cachedLogin = info.login
        return info
    }

    override async getPositions(credentials: MT5AccountCredentials): Promise<MT5Position[]> {
        const accountId = await this.ensureAccount(credentials)
        const response = await this.requestJson<{ positions: FiveSocketPosition[] }>(
            "GET",
            `/v1/accounts/${encodeURIComponent(accountId)}/positions`,
            {
                timeout: this.fsTimeout,
                retry: true,
            }
        )
        return (response.positions ?? []).map(mapFiveSocketPosition)
    }

    override async getOpenOrders(credentials: MT5AccountCredentials): Promise<MT5OpenOrder[]> {
        const accountId = await this.ensureAccount(credentials)
        const response = await this.requestJson<{ data: FiveSocketWorkingOrder[] }>(
            "GET",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution/orders`,
            {
                timeout: this.fsTimeout,
                retry: true,
            }
        )
        return (response.data ?? []).map(mapFiveSocketWorkingOrder)
    }

    override async getPositionClosures(
        credentials: MT5AccountCredentials,
        lookbackHours: number = 24
    ): Promise<MT5PositionClosure[]> {
        const deals = await this.listDeals(credentials, lookbackHours)
        return mapFiveSocketPositionClosures(deals)
    }

    override async getAccountPnlEvents(
        credentials: MT5AccountCredentials,
        lookbackHours: number = 24
    ): Promise<MT5AccountPnlEvent[]> {
        const snapshot = await this.getAccountStateSnapshot(credentials, lookbackHours)
        return snapshot.accountPnlEvents
    }

    override async getAccountStateSnapshot(
        credentials: MT5AccountCredentials,
        lookbackHours: number = 24
    ): Promise<MT5AccountStateSnapshot> {
        const account = await this.getAccount(credentials)
        const deals = await this.listDeals(credentials, lookbackHours)

        return {
            account,
            positionClosures: mapFiveSocketPositionClosures(deals),
            accountPnlEvents: mapFiveSocketAccountPnlEvents(deals, account.currency),
        }
    }

    override async submitOrder(credentials: MT5AccountCredentials, params: {
        symbol: string
        side: string
        volume: number
        orderType?: string
        price?: number
        stopLoss?: number
        takeProfit?: number
        magic?: number
        comment?: string
        deviation?: number
    }): Promise<MT5OrderResult> {
        const clientOrderId = requireClientOrderId(params.comment)
        const accountId = await this.ensureAccount(credentials)
        const side = normalizeSide(params.side)
        const type = normalizeOrderType(params.orderType)

        const body: Record<string, unknown> = {
            clientOrderId,
            symbol: params.symbol,
            side,
            type,
            volume: toVolumeDecimalString(params.volume),
            magic: toUnsignedIntString(params.magic ?? 0),
        }

        if (params.price !== undefined) {
            body.price = toPriceDecimalString(params.price)
        }
        if (params.stopLoss !== undefined) {
            body.stopLoss = toPriceDecimalString(params.stopLoss)
        }
        if (params.takeProfit !== undefined) {
            body.takeProfit = toPriceDecimalString(params.takeProfit)
        }
        if (params.deviation !== undefined) {
            body.deviationPoints = params.deviation
        }

        const command = await this.mutateExecutionCommand(
            accountId,
            "POST",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution/orders`,
            body,
            clientOrderId
        )
        return await this.resolveMutationCommand(accountId, command)
    }

    override async modifyOrder(credentials: MT5AccountCredentials, params: {
        ticket: number
        price?: number
        stopLoss?: number
        takeProfit?: number
    }): Promise<MT5OrderResult> {
        const accountId = await this.ensureAccount(credentials)
        const body: Record<string, unknown> = {}
        if (params.price !== undefined) {
            body.price = toPriceDecimalString(params.price)
        }
        if (params.stopLoss !== undefined) {
            body.stopLoss = toPriceDecimalString(params.stopLoss)
        }
        if (params.takeProfit !== undefined) {
            body.takeProfit = toPriceDecimalString(params.takeProfit)
        }

        const idempotencyKey = createAttemptIdempotencyKey("modify", params.ticket)
        const command = await this.mutateExecutionCommand(
            accountId,
            "PATCH",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution/orders/${encodeURIComponent(String(params.ticket))}`,
            body,
            idempotencyKey
        )
        return await this.resolveMutationCommand(accountId, command)
    }

    override async cancelOrder(credentials: MT5AccountCredentials, params: {
        ticket: number
    }): Promise<MT5OrderResult> {
        const accountId = await this.ensureAccount(credentials)
        const idempotencyKey = createAttemptIdempotencyKey("cancel", params.ticket)
        const command = await this.mutateExecutionCommand(
            accountId,
            "DELETE",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution/orders/${encodeURIComponent(String(params.ticket))}`,
            undefined,
            idempotencyKey
        )
        return await this.resolveMutationCommand(accountId, command)
    }

    override async closePosition(credentials: MT5AccountCredentials, params: {
        ticket: number
        volume?: number
        deviation?: number
        comment?: string
    }): Promise<MT5OrderResult> {
        const clientOrderId = requireClientOrderId(params.comment)
        const accountId = await this.ensureAccount(credentials)
        const body: Record<string, unknown> = {
            clientOrderId,
        }
        if (params.volume !== undefined) {
            body.volume = toVolumeDecimalString(params.volume)
        }
        if (params.deviation !== undefined) {
            body.deviationPoints = params.deviation
        }

        const command = await this.mutateExecutionCommand(
            accountId,
            "POST",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution/positions/${encodeURIComponent(String(params.ticket))}/close`,
            body,
            clientOrderId
        )
        return await this.resolveMutationCommand(accountId, command)
    }

    override async getSymbolInfo(credentials: MT5AccountCredentials, symbols: string[]): Promise<MT5SymbolInfo[]> {
        if (symbols.length === 0) {
            return []
        }

        const accountId = await this.ensureAccount(credentials)
        const query = new URLSearchParams({
            symbols: symbols.join(","),
        })
        const response = await this.requestJson<{
            data: FiveSocketExecutionSymbol[]
            missing: string[]
        }>(
            "GET",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution/symbols?${query.toString()}`,
            {
                timeout: this.fsTimeout,
                retry: true,
            }
        )

        if ((response.missing ?? []).length > 0) {
            throw createExecutionError(
                "venue",
                `symbol_select failed: missing symbols ${response.missing.join(", ")}`,
                {
                    code: "symbol_unavailable",
                    retryable: false,
                    details: {
                        missing: response.missing,
                    },
                }
            )
        }

        return (response.data ?? []).map(mapFiveSocketExecutionSymbol)
    }

    override async getOrderStatus(credentials: MT5AccountCredentials, orderId: number): Promise<{
        ticket: number
        symbol: string
        type: string
        volume: number
        volumeInitial?: number
        price: number
        profit?: number
        commission?: number
        swap?: number
        fee?: number
        positionId?: number
        state: string
    } | null> {
        const accountId = await this.ensureAccount(credentials)
        try {
            const response = await this.requestJson<{
                order: FiveSocketWorkingOrder
                deals: FiveSocketDeal[]
            }>(
                "GET",
                `/v1/accounts/${encodeURIComponent(accountId)}/execution/orders/${encodeURIComponent(String(orderId))}`,
                {
                    timeout: this.fsTimeout,
                    retry: true,
                }
            )
            const order = response.order
            const volumeInitial = fromRequiredDecimal(order.volumeInitial, "order.volumeInitial")
            const volumeCurrent = fromRequiredDecimal(order.volumeCurrent, "order.volumeCurrent")
            const dealTotals = summarizeDeals(response.deals ?? [])

            return {
                ticket: fromRequiredUnsignedInt(order.id, "order.id"),
                symbol: order.symbol,
                type: order.type,
                volume: volumeCurrent,
                volumeInitial,
                price: fromRequiredDecimal(order.priceOpen, "order.priceOpen"),
                profit: dealTotals.profit,
                commission: dealTotals.commission,
                swap: dealTotals.swap,
                fee: dealTotals.fee,
                positionId: fromRequiredUnsignedInt(order.positionId, "order.positionId"),
                state: order.state,
            }
        } catch (error) {
            const detail = getExecutionErrorDetail(error)
            const status = detail?.details?.status
            if (status === 404 || detail?.code === "order_not_found") {
                return null
            }
            throw error
        }
    }

    private async ensureAccount(
        credentials: MT5AccountCredentials,
        budget?: TimeoutBudget
    ): Promise<string> {
        const cacheKey = accountCacheKey(credentials)
        const cached = this.accountIdByKey.get(cacheKey)
        if (cached) {
            await this.configureExecutionIfChanged(cached, budget)
            return cached
        }

        const linkBudget = budget ?? createTimeoutBudget(this.fsConnectTimeout)
        const inFlight = this.accountLinkStateByKey.get(cacheKey)
        if (inFlight) {
            const accountId = await inFlight.promise
            await this.configureExecutionIfChanged(accountId, budget)
            return accountId
        }

        const linkPromise = this.linkAccount(credentials, cacheKey, linkBudget)
        this.accountLinkStateByKey.set(cacheKey, { promise: linkPromise })

        try {
            return await linkPromise
        } finally {
            const current = this.accountLinkStateByKey.get(cacheKey)
            if (current?.promise === linkPromise) {
                this.accountLinkStateByKey.delete(cacheKey)
            }
        }
    }

    private async linkAccount(
        credentials: MT5AccountCredentials,
        cacheKey: string,
        budget: TimeoutBudget
    ): Promise<string> {
        const login = String(credentials.login)
        const idempotencyKey = `account:${login}:${credentials.server}`
        let linked: LinkedAccount

        try {
            linked = await this.requestJson<LinkedAccount>(
                "POST",
                "/v1/accounts",
                {
                    body: {
                        login,
                        password: credentials.password,
                        server: credentials.server,
                    },
                    budget,
                    retry: false,
                    idempotencyKey,
                    acceptStatuses: [201],
                    bypassPacing: true,
                }
            )
        } catch (error) {
            const detail = getExecutionErrorDetail(error)
            if (detail?.code === "conflict" || detail?.code === "409") {
                linked = await this.findLinkedAccount(credentials, budget)
            } else {
                throw error
            }
        }

        if (linked.status !== "active" && linked.status !== "pending") {
            throw createExecutionError(
                "venue",
                `FiveSocket account ${linked.id} status is ${linked.status}`,
                {
                    code: "account_disabled",
                    retryable: false,
                    details: {
                        accountId: linked.id,
                        status: linked.status,
                        login: credentials.login,
                        server: credentials.server,
                    },
                }
            )
        }

        await this.configureExecutionIfChanged(linked.id, budget)
        this.accountIdByKey.set(cacheKey, linked.id)
        this.cachedLogin = credentials.login
        return linked.id
    }

    private async findLinkedAccount(
        credentials: MT5AccountCredentials,
        budget: TimeoutBudget
    ): Promise<LinkedAccount> {
        const response = await this.requestJson<{ data: LinkedAccount[] }>(
            "GET",
            "/v1/accounts",
            {
                budget,
                retry: true,
                bypassPacing: true,
            }
        )
        const login = String(credentials.login)
        const match = (response.data ?? []).find((account) =>
            account.login === login && account.server === credentials.server
        )
        if (!match) {
            throw createExecutionError(
                "venue",
                `FiveSocket account for login ${credentials.login} on ${credentials.server} was not found after conflict`,
                {
                    code: "account_not_found",
                    retryable: false,
                    details: {
                        login: credentials.login,
                        server: credentials.server,
                    },
                }
            )
        }
        return match
    }

    private async configureExecutionIfChanged(
        accountId: string,
        budget?: TimeoutBudget
    ): Promise<void> {
        const queued = this.executionPolicyQueueByAccountId.get(accountId) ?? Promise.resolve()
        const next = queued.then(async () => {
            const symbols = this.resolveExecutionSymbols()
            const policyKey = executionPolicyKey(symbols)
            const configuredKey = this.configuredExecutionPolicyKeyByAccountId.get(accountId)
            if (configuredKey === policyKey) {
                return
            }

            if (symbols.length === 0) {
                if (configuredKey !== undefined) {
                    throw createExecutionError(
                        "pre_validation",
                        `FiveSocket execution policy for account ${accountId} cannot be cleared without configured symbols`,
                        {
                            code: "MISSING_EXECUTION_SYMBOLS",
                            retryable: false,
                            details: {
                                accountId,
                            },
                        }
                    )
                }
                return
            }

            if (configuredKey !== undefined) {
                console.warn("FiveSocket execution policy changed; reconfiguring account", {
                    accountId,
                    previousPolicyKey: configuredKey,
                    nextPolicyKey: policyKey,
                    symbols: symbols.map((symbol) => symbol.symbol),
                })
            }

            const configurationBudget = budget ?? createTimeoutBudget(this.fsConnectTimeout)
            const idempotencyKey = `execution:${accountId}:${stableBodyKey({ symbols })}`
            await this.requestJson(
                "PUT",
                `/v1/accounts/${encodeURIComponent(accountId)}/execution`,
                {
                    body: { symbols },
                    budget: configurationBudget,
                    retry: false,
                    idempotencyKey,
                    acceptStatuses: [200],
                    bypassPacing: true,
                }
            )
            this.configuredExecutionPolicyKeyByAccountId.set(accountId, policyKey)
        })

        this.executionPolicyQueueByAccountId.set(accountId, next.catch(() => undefined))
        await next
    }

    private resolveExecutionSymbols(): FiveSocketExecutionSymbolPolicy[] {
        return [...this.executionSymbols]
    }

    private async listDeals(
        credentials: MT5AccountCredentials,
        lookbackHours: number
    ): Promise<FiveSocketDeal[]> {
        const accountId = await this.ensureAccount(credentials)
        const to = new Date()
        const requestedFromMs = to.getTime() - Math.max(lookbackHours, 1) * 60 * 60 * 1000
        const watermarkMs = this.dealWatermarkByAccountId.get(accountId)
        const fromMs = watermarkMs === undefined
            ? requestedFromMs
            : Math.max(requestedFromMs, watermarkMs - DEAL_WATERMARK_OVERLAP_MS)
        const from = new Date(fromMs)
        const deals: FiveSocketDeal[] = []
        const seenDealIds = new Set<string>()
        let cursor: string | null = null
        const maxPages = this.maxDealPages

        for (let page = 0; page < maxPages; page += 1) {
            const query = new URLSearchParams({
                from: from.toISOString(),
                to: to.toISOString(),
                limit: "200",
            })
            if (cursor) {
                query.set("cursor", cursor)
            }

            const response = await this.requestJson<{
                data: FiveSocketDeal[]
                nextCursor: string | null
            }>(
                "GET",
                `/v1/accounts/${encodeURIComponent(accountId)}/deals?${query.toString()}`,
                {
                    timeout: this.fsTimeout,
                    retry: true,
                }
            )

            for (const deal of response.data ?? []) {
                if (seenDealIds.has(deal.id)) {
                    continue
                }
                seenDealIds.add(deal.id)
                deals.push(deal)
            }
            cursor = response.nextCursor
            if (!cursor) {
                this.rememberDealWatermark(accountId, deals)
                return deals
            }
        }

        throw createExecutionError(
            "venue",
            `FiveSocket deals pagination exceeded ${maxPages} pages without exhausting nextCursor`,
            {
                code: "DEALS_PAGINATION_EXHAUSTED",
                retryable: false,
                details: {
                    accountId,
                    pages: maxPages,
                    collected: deals.length,
                },
            }
        )
    }

    private rememberDealWatermark(accountId: string, deals: readonly FiveSocketDeal[]): void {
        let newest = this.dealWatermarkByAccountId.get(accountId) ?? 0
        for (const deal of deals) {
            const timestamp = Date.parse(deal.time) || 0
            if (timestamp > newest) {
                newest = timestamp
            }
        }
        if (newest > 0) {
            this.dealWatermarkByAccountId.set(accountId, newest)
        }
    }

    private async mutateExecutionCommand(
        accountId: string,
        method: "POST" | "PATCH" | "DELETE",
        path: string,
        body: unknown,
        idempotencyKey: string
    ): Promise<FiveSocketExecutionCommand> {
        return await this.requestJson<FiveSocketExecutionCommand>(
            method,
            path,
            {
                body,
                timeout: this.fsTimeout,
                retry: false,
                idempotencyKey,
                acceptStatuses: [200, 202],
                bypassPacing: true,
            }
        )
    }

    private async resolveMutationCommand(
        accountId: string,
        command: FiveSocketExecutionCommand
    ): Promise<MT5OrderResult> {
        let current = command

        if (current.outcome === "commit_unknown") {
            current = await this.pollCommand(accountId, current)
        }

        if (current.outcome === "commit_unknown") {
            throw createExecutionError(
                "venue",
                current.retcodeDescription || "FiveSocket commit unknown",
                {
                    code: "commit_unknown",
                    retryable: true,
                    details: {
                        commandId: current.commandId,
                        operation: current.operation,
                        status: current.status,
                        recovered: current.recovered,
                    },
                }
            )
        }

        return mapFiveSocketExecutionCommand(current)
    }

    private async pollCommand(
        accountId: string,
        command: FiveSocketExecutionCommand
    ): Promise<FiveSocketExecutionCommand> {
        let current = command

        for (let attempt = 0; attempt < this.commandPollAttempts; attempt += 1) {
            if (current.outcome !== "commit_unknown") {
                return current
            }

            await sleep(this.commandPollDelayMs)
            current = await this.requestJson<FiveSocketExecutionCommand>(
                "GET",
                `/v1/accounts/${encodeURIComponent(accountId)}/execution/commands/${encodeURIComponent(current.commandId)}`,
                {
                    timeout: this.fsTimeout,
                    retry: true,
                    acceptStatuses: [200, 202],
                    bypassPacing: true,
                }
            )
        }

        return current
    }

    private async requestJson<T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        options: {
            body?: unknown
            timeout?: number
            budget?: TimeoutBudget
            retry: boolean
            auth?: boolean
            idempotencyKey?: string
            acceptStatuses?: number[]
            bypassPacing?: boolean
        }
    ): Promise<T> {
        if (options.budget === undefined && options.timeout === undefined) {
            throw new Error("FiveSocket requestJson requires timeout or budget")
        }
        const retryBudget = options.budget ?? (options.retry ? createOperationTimeoutBudget(options.timeout!) : undefined)

        const execute = async (): Promise<T> => {
            const requestBudget = options.budget
            if (options.bypassPacing !== true) {
                await this.waitForRequestPacing(options.budget)
            }
            const timeout = requestBudget?.remaining() ?? options.timeout!
            const headers: Record<string, string> = {
                Accept: "application/json",
            }
            if (options.auth !== false) {
                headers.Authorization = `Bearer ${this.apiKey}`
            }
            if (options.body !== undefined) {
                headers["Content-Type"] = "application/json"
            }
            if (options.idempotencyKey) {
                headers["Idempotency-Key"] = options.idempotencyKey
            }

            try {
                const response = await fetchWithTimeout(
                    `${this.fsBaseUrl}${path}`,
                    {
                        method,
                        headers,
                        body: options.body === undefined ? undefined : JSON.stringify(options.body),
                    },
                    timeout,
                    `FiveSocket ${method} ${path}`,
                    this.fsFetchImpl
                )

                const acceptStatuses = options.acceptStatuses ?? [200]
                if (!acceptStatuses.includes(response.status)) {
                    const text = await readResponseText(response, requestBudget)
                    const apiError = parseApiError(text)
                    const retryAfterMs = response.status === 429
                        ? resolveRetryAfterMs(readRetryAfterHeader(response), apiError)
                        : undefined
                    throw createExecutionError(
                        "venue",
                        `FiveSocket error: ${response.status} ${response.statusText} ${apiError?.message ?? text}`.trim(),
                        {
                            code: apiError?.code ?? String(response.status),
                            retryable: response.status >= 500 || response.status === 429,
                            details: {
                                path,
                                status: response.status,
                                statusText: response.statusText,
                                body: text,
                                apiError,
                                retryAfterMs,
                            },
                        }
                    )
                }

                if (response.status === 204) {
                    return undefined as T
                }

                return await readResponseJson<T>(response, requestBudget)
            } catch (error) {
                const detail = getExecutionErrorDetail(error)
                if (detail) {
                    const budgetExhausted = asBudgetExhausted(error)
                    if (budgetExhausted) {
                        throw budgetExhausted
                    }
                    throw error
                }

                if (requestBudget) {
                    const budgetExhausted = asBudgetExhausted(error)
                    if (budgetExhausted) {
                        throw budgetExhausted
                    }
                    try {
                        requestBudget.remaining()
                    } catch (budgetError) {
                        throw asBudgetExhausted(budgetError) ?? budgetError
                    }
                }

                throw createExecutionError("network", getErrorMessage(error), {
                    code: "FIVESOCKET_NETWORK",
                    retryable: true,
                    details: {
                        method,
                        path,
                        baseUrl: this.fsBaseUrl,
                    },
                })
            }
        }

        if (!options.retry) {
            return await execute()
        }

        return await retryFiveSocketRequest(execute, retryBudget, 3, 1000, {
            failWithBudgetError: options.budget !== undefined,
        })
    }

    private async waitForRequestPacing(budget?: TimeoutBudget): Promise<void> {
        if (this.minRequestIntervalMs <= 0) {
            return
        }

        const turn = this.pacingQueue.then(async () => {
            const delay = Math.max(this.nextPacedRequestStartAt - Date.now(), 0)
            if (delay > 0) {
                ensureBudgetCanCoverDelay(budget, delay, {
                    reason: "request_pacing",
                })
                await sleep(delay)
            }
            this.nextPacedRequestStartAt = Date.now() + this.minRequestIntervalMs
        })

        this.pacingQueue = turn.catch(() => undefined)
        await turn
    }
}

function accountCacheKey(credentials: MT5AccountCredentials): string {
    return `${credentials.login}:${credentials.server}`
}

function normalizeExecutionSymbols(
    symbols: readonly FiveSocketExecutionSymbolPolicy[]
): FiveSocketExecutionSymbolPolicy[] {
    const bySymbol = new Map<string, string>()

    for (const entry of symbols) {
        const symbol = entry.symbol.trim()
        if (!symbol) {
            throw createExecutionError(
                "pre_validation",
                "FiveSocket execution symbol is required",
                {
                    code: "MISSING_EXECUTION_SYMBOL",
                    retryable: false,
                }
            )
        }

        const maxVolume = entry.maxVolume.trim()
        if (!maxVolume) {
            throw createExecutionError(
                "pre_validation",
                `FiveSocket execution maxVolume is required for symbol ${symbol}`,
                {
                    code: "MISSING_MAX_VOLUME",
                    retryable: false,
                    details: { symbol },
                }
            )
        }
        if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(maxVolume) || Number(maxVolume) <= 0) {
            throw createExecutionError(
                "pre_validation",
                `FiveSocket execution maxVolume must be a positive plain decimal string for symbol ${symbol}`,
                {
                    code: "INVALID_MAX_VOLUME",
                    retryable: false,
                    details: {
                        symbol,
                        maxVolume: entry.maxVolume,
                    },
                }
            )
        }

        const existing = bySymbol.get(symbol)
        if (existing !== undefined && existing !== maxVolume) {
            throw createExecutionError(
                "pre_validation",
                `FiveSocket execution symbol ${symbol} has conflicting maxVolume policies`,
                {
                    code: "CONFLICTING_EXECUTION_SYMBOL_POLICY",
                    retryable: false,
                    details: {
                        symbol,
                        firstMaxVolume: existing,
                        nextMaxVolume: maxVolume,
                    },
                }
            )
        }
        bySymbol.set(symbol, maxVolume)
    }

    return [...bySymbol.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([symbol, maxVolume]) => ({
            symbol,
            maxVolume,
        }))
}

function executionPolicyKey(symbols: readonly FiveSocketExecutionSymbolPolicy[]): string {
    return stableBodyKey({ symbols })
}

type TimeoutBudget = {
    remaining: () => number
    exhaustedError: (details?: Record<string, unknown>) => Error
}

function createTimeoutBudget(totalMs: number): TimeoutBudget {
    return createBudget(totalMs, createConnectBudgetExhaustedError)
}

function createOperationTimeoutBudget(totalMs: number): TimeoutBudget {
    return createBudget(totalMs, createOperationBudgetExhaustedError)
}

function createBudget(
    totalMs: number,
    exhaustedError: (details?: Record<string, unknown>) => Error
): TimeoutBudget {
    const deadline = Date.now() + totalMs
    return {
        exhaustedError,
        remaining: () => {
            const left = deadline - Date.now()
            if (left <= 0) {
                throw exhaustedError({ totalMs })
            }
            return left
        },
    }
}

async function retryFiveSocketRequest<T>(
    execute: () => Promise<T>,
    budget: TimeoutBudget | undefined,
    maxRetries: number,
    baseDelay: number,
    options: {
        failWithBudgetError: boolean
    }
): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await execute()
        } catch (error) {
            lastError = error
            const budgetExhausted = asBudgetExhausted(error)
            if (budgetExhausted) {
                throw budgetExhausted
            }
            const detail = getExecutionErrorDetail(error)
            const shouldRetry = attempt < maxRetries && detail?.retryable === true
            if (!shouldRetry) {
                throw error
            }

            const delay = resolveRetryDelayMs(error, attempt, baseDelay)
            if (!budget) {
                await sleep(delay)
                continue
            }

            let remaining: number
            try {
                remaining = budget.remaining()
            } catch (budgetError) {
                const exhausted = asBudgetExhausted(budgetError) ?? budget.exhaustedError({
                    remainingMs: 0,
                    requiredBackoffMs: delay,
                    attempt,
                })
                if (options.failWithBudgetError) {
                    throw exhausted
                }
                throw error
            }
            if (remaining <= delay) {
                if (options.failWithBudgetError) {
                    throw budget.exhaustedError({
                        remainingMs: remaining,
                        requiredBackoffMs: delay,
                        attempt,
                    })
                }
                throw error
            }
            await sleep(delay)
        }
    }
    throw lastError
}

async function readResponseText(
    response: Response,
    budget?: TimeoutBudget
): Promise<string> {
    return await readUnderBudget(
        budget,
        "FiveSocket response body",
        async () => await response.text().catch(() => "")
    )
}

async function readResponseJson<T>(
    response: Response,
    budget?: TimeoutBudget
): Promise<T> {
    return await readUnderBudget(
        budget,
        "FiveSocket response json",
        async () => (await response.json()) as T
    )
}

async function readUnderBudget<T>(
    budget: TimeoutBudget | undefined,
    name: string,
    operation: () => Promise<T>
): Promise<T> {
    if (!budget) {
        return await operation()
    }

    const remaining = budget.remaining()
    try {
        return await withTimeout(operation, remaining, name)
    } catch (error) {
        const alreadyExhausted = asBudgetExhausted(error)
        if (alreadyExhausted) {
            throw alreadyExhausted
        }
        if (error instanceof OperationTimeoutError) {
            throw budget.exhaustedError({
                name,
                remainingMs: 0,
            })
        }
        throw error
    }
}

function asBudgetExhausted(error: unknown): Error | undefined {
    const detail = getExecutionErrorDetail(error)
    if (detail?.code === "CONNECT_BUDGET_EXHAUSTED") {
        return error instanceof Error ? error : createConnectBudgetExhaustedError()
    }
    if (detail?.code === "FIVESOCKET_OPERATION_BUDGET_EXHAUSTED") {
        return error instanceof Error ? error : createOperationBudgetExhaustedError()
    }
    return undefined
}

function createConnectBudgetExhaustedError(details: Record<string, unknown> = {}): Error {
    return createExecutionError(
        "timeout",
        "FiveSocket connect budget exhausted",
        {
            code: "CONNECT_BUDGET_EXHAUSTED",
            retryable: true,
            details,
        }
    )
}

function createOperationBudgetExhaustedError(details: Record<string, unknown> = {}): Error {
    return createExecutionError(
        "timeout",
        "FiveSocket operation budget exhausted",
        {
            code: "FIVESOCKET_OPERATION_BUDGET_EXHAUSTED",
            retryable: true,
            details,
        }
    )
}

function ensureBudgetCanCoverDelay(
    budget: TimeoutBudget | undefined,
    delayMs: number,
    details: Record<string, unknown>
): void {
    if (!budget) {
        return
    }

    let remaining: number
    try {
        remaining = budget.remaining()
    } catch (error) {
        throw asBudgetExhausted(error) ?? budget.exhaustedError({
            ...details,
            remainingMs: 0,
            requiredDelayMs: delayMs,
        })
    }
    if (remaining <= delayMs) {
        throw budget.exhaustedError({
            ...details,
            remainingMs: remaining,
            requiredDelayMs: delayMs,
        })
    }
}

function resolveRetryDelayMs(error: unknown, attempt: number, baseDelay: number): number {
    return Math.max(baseDelay * Math.pow(2, attempt), readRetryAfterDelayMs(error) ?? 0)
}

function readRetryAfterDelayMs(error: unknown): number | undefined {
    const value = getExecutionErrorDetail(error)?.details?.retryAfterMs
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined
}

function readRetryAfterHeader(response: Response): string | null {
    return (response as { headers?: Headers }).headers?.get("Retry-After") ?? null
}

function resolveRetryAfterMs(headerValue: string | null, apiError: FiveSocketApiError | undefined): number | undefined {
    const headerMs = parseRetryAfterValue(headerValue)
    const bodyMs = apiError?.retryAfterMs
    if (headerMs === undefined) {
        return bodyMs
    }
    if (bodyMs === undefined) {
        return headerMs
    }
    return Math.max(headerMs, bodyMs)
}

function parseRetryAfterValue(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined
    }
    if (typeof value !== "string") {
        return undefined
    }

    const trimmed = value.trim()
    if (!trimmed) {
        return undefined
    }
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000
    }

    const timestamp = Date.parse(trimmed)
    return Number.isFinite(timestamp)
        ? Math.max(timestamp - Date.now(), 0)
        : undefined
}

function normalizeMinRequestIntervalMs(value: number | undefined): number {
    const interval = value ?? DEFAULT_MIN_REQUEST_INTERVAL_MS
    if (!Number.isFinite(interval) || interval < 0) {
        throw createExecutionError(
            "pre_validation",
            `FiveSocket minRequestIntervalMs must be a finite non-negative number, received: ${String(value)}`,
            {
                code: "INVALID_MIN_REQUEST_INTERVAL_MS",
                retryable: false,
                details: {
                    minRequestIntervalMs: value,
                },
            }
        )
    }
    return interval
}

function sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function createAttemptIdempotencyKey(operation: "modify" | "cancel", ticket: number): string {
    return `${operation}:${ticket}:${crypto.randomUUID()}`
}

function requireClientOrderId(comment: string | undefined): string {
    const value = comment
    if (!value) {
        throw createExecutionError(
            "pre_validation",
            "FiveSocket mutations require clientOrderId via comment",
            {
                code: "MISSING_CLIENT_ORDER_ID",
                retryable: false,
            }
        )
    }
    if (value.length > 31 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
        throw createExecutionError(
            "pre_validation",
            `FiveSocket clientOrderId must match ^[A-Za-z0-9._:-]+$ and be 1..31 chars, received: ${value}`,
            {
                code: "INVALID_CLIENT_ORDER_ID",
                retryable: false,
                details: {
                    clientOrderId: value,
                    length: value.length,
                },
            }
        )
    }
    return value
}

function normalizeSide(side: string): "buy" | "sell" {
    const normalized = side.trim().toLowerCase()
    if (normalized === "buy" || normalized === "long") {
        return "buy"
    }
    if (normalized === "sell" || normalized === "short") {
        return "sell"
    }
    throw createExecutionError("pre_validation", `Unsupported FiveSocket side: ${side}`, {
        code: "INVALID_SIDE",
        retryable: false,
        details: { side },
    })
}

function normalizeOrderType(orderType: string | undefined): "market" | "limit" | "stop" | "stop_limit" {
    const normalized = (orderType ?? "market").trim().toLowerCase()
    if (normalized === "market") {
        return "market"
    }
    if (normalized === "limit") {
        return "limit"
    }
    if (normalized === "stop") {
        return "stop"
    }
    if (normalized === "stop_limit" || normalized === "stoplimit") {
        return "stop_limit"
    }
    throw createExecutionError("pre_validation", `Unsupported FiveSocket order type: ${orderType}`, {
        code: "INVALID_ORDER_TYPE",
        retryable: false,
        details: { orderType },
    })
}

function parseApiError(text: string): FiveSocketApiError | undefined {
    if (!text.trim()) {
        return undefined
    }

    try {
        const parsed = JSON.parse(text) as FiveSocketApiErrorBody
        if (parsed.error) {
            return {
                ...parsed.error,
                retryAfterMs: parseRetryAfterValue(parsed.error.retryAfter ?? parsed.retryAfter),
            }
        }
        const retryAfterMs = parseRetryAfterValue(parsed.retryAfter)
        if (retryAfterMs !== undefined) {
            return { retryAfterMs }
        }
    } catch {
        return undefined
    }

    return undefined
}

function stableBodyKey(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function fromRequiredDecimal(value: string, field: string): number {
    return fromDecimalString(value, field)
}

function fromRequiredUnsignedInt(value: string, field: string): number {
    return fromSafeIntegerString(value, field)
}

function summarizeDeals(deals: FiveSocketDeal[]): {
    profit?: number
    commission?: number
    swap?: number
    fee?: number
} {
    if (deals.length === 0) {
        return {}
    }

    let profit = 0
    let commission = 0
    let swap = 0
    let fee = 0
    for (const deal of deals) {
        profit += fromRequiredDecimal(deal.profit, "deal.profit")
        commission += fromRequiredDecimal(deal.commission, "deal.commission")
        swap += fromRequiredDecimal(deal.swap, "deal.swap")
        fee += fromRequiredDecimal(deal.fee, "deal.fee")
    }

    return { profit, commission, swap, fee }
}
