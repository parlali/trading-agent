import {
    createExecutionError,
    fetchWithTimeout,
    getErrorMessage,
    getExecutionErrorDetail,
    retryWithBackoff,
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
    type MT5WorkerCredentials,
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
}

type FiveSocketApiErrorBody = {
    error?: {
        code?: string
        message?: string
        requestId?: string
    }
}

type LinkedAccount = {
    id: string
    login: string
    server: string
    status: string
}

export class FiveSocketClient extends MT5Client {
    private readonly fsBaseUrl: string
    private readonly apiKey: string
    private readonly fsTimeout: number
    private readonly fsConnectTimeout: number
    private readonly fsFetchImpl: typeof fetch
    private readonly executionSymbols: readonly FiveSocketExecutionSymbolPolicy[]
    private readonly commandPollAttempts: number
    private readonly commandPollDelayMs: number
    private readonly maxDealPages: number
    private readonly accountIdByKey = new Map<string, string>()
    private cachedLogin: number | null = null

    constructor(config: FiveSocketClientConfig) {
        super({
            workerUrl: config.baseUrl,
            accessKey: config.apiKey,
            timeout: config.timeout,
            connectTimeout: config.connectTimeout,
            fetchImpl: config.fetchImpl,
        })
        this.fsBaseUrl = config.baseUrl.replace(/\/$/, "")
        this.apiKey = config.apiKey
        this.fsTimeout = config.timeout ?? 30_000
        this.fsConnectTimeout = config.connectTimeout ?? Math.max(this.fsTimeout, 90_000)
        this.fsFetchImpl = config.fetchImpl ?? fetch
        this.executionSymbols = config.executionSymbols ?? []
        this.commandPollAttempts = config.commandPollAttempts ?? 3
        this.commandPollDelayMs = config.commandPollDelayMs ?? 250
        this.maxDealPages = config.maxDealPages ?? 10_000
    }

    override async connect(credentials: MT5WorkerCredentials): Promise<MT5AccountInfo> {
        const budget = createTimeoutBudget(this.fsConnectTimeout)
        await this.ensureAccount(credentials, budget)
        return await this.readAccountInfo(credentials, budget)
    }

    override async disconnect(): Promise<void> {
    }

    override async getHealth(): Promise<{ status: string; connected: boolean; login: number | null }> {
        const readiness = await this.requestJson<FiveSocketApiReadiness>(
            "GET",
            "/ready",
            {
                timeout: this.fsTimeout,
                retry: true,
                auth: false,
            }
        )
        return mapFiveSocketReadiness(readiness, this.cachedLogin)
    }

    override async getAccount(credentials: MT5WorkerCredentials): Promise<MT5AccountInfo> {
        return await this.readAccountInfo(credentials)
    }

    private async readAccountInfo(
        credentials: MT5WorkerCredentials,
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

    override async getPositions(credentials: MT5WorkerCredentials): Promise<MT5Position[]> {
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

    override async getOpenOrders(credentials: MT5WorkerCredentials): Promise<MT5OpenOrder[]> {
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
        credentials: MT5WorkerCredentials,
        lookbackHours: number = 24
    ): Promise<MT5PositionClosure[]> {
        const deals = await this.listDeals(credentials, lookbackHours)
        return mapFiveSocketPositionClosures(deals)
    }

    override async getAccountPnlEvents(
        credentials: MT5WorkerCredentials,
        lookbackHours: number = 24
    ): Promise<MT5AccountPnlEvent[]> {
        const account = await this.getAccount(credentials)
        const deals = await this.listDeals(credentials, lookbackHours)
        return mapFiveSocketAccountPnlEvents(deals, account.currency)
    }

    override async submitOrder(credentials: MT5WorkerCredentials, params: {
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

    override async modifyOrder(credentials: MT5WorkerCredentials, params: {
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

    override async cancelOrder(credentials: MT5WorkerCredentials, params: {
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

    override async closePosition(credentials: MT5WorkerCredentials, params: {
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

    override async getSymbolInfo(credentials: MT5WorkerCredentials, symbols: string[]): Promise<MT5SymbolInfo[]> {
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

    override async getOrderStatus(credentials: MT5WorkerCredentials, orderId: number): Promise<{
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
        credentials: MT5WorkerCredentials,
        budget?: TimeoutBudget
    ): Promise<string> {
        const cacheKey = accountCacheKey(credentials)
        const cached = this.accountIdByKey.get(cacheKey)
        if (cached) {
            return cached
        }

        const linkBudget = budget ?? createTimeoutBudget(this.fsConnectTimeout)
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
                    budget: linkBudget,
                    retry: false,
                    idempotencyKey,
                    acceptStatuses: [201],
                }
            )
        } catch (error) {
            const detail = getExecutionErrorDetail(error)
            if (detail?.code === "conflict" || detail?.code === "409") {
                linked = await this.findLinkedAccount(credentials, linkBudget)
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

        await this.configureExecution(linked.id, linkBudget)
        this.accountIdByKey.set(cacheKey, linked.id)
        this.cachedLogin = credentials.login
        return linked.id
    }

    private async findLinkedAccount(
        credentials: MT5WorkerCredentials,
        budget: TimeoutBudget
    ): Promise<LinkedAccount> {
        const response = await this.requestJson<{ data: LinkedAccount[] }>(
            "GET",
            "/v1/accounts",
            {
                budget,
                retry: true,
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

    private async configureExecution(
        accountId: string,
        budget: TimeoutBudget
    ): Promise<void> {
        const symbols = this.resolveExecutionSymbols()
        if (symbols.length === 0) {
            return
        }

        const idempotencyKey = `execution:${accountId}:${stableBodyKey({ symbols })}`
        await this.requestJson(
            "PUT",
            `/v1/accounts/${encodeURIComponent(accountId)}/execution`,
            {
                body: { symbols },
                budget,
                retry: false,
                idempotencyKey,
                acceptStatuses: [200],
            }
        )
    }

    private resolveExecutionSymbols(): FiveSocketExecutionSymbolPolicy[] {
        if (this.executionSymbols.length === 0) {
            return []
        }
        return this.executionSymbols.map((entry) => {
            const maxVolume = entry.maxVolume.trim()
            if (!maxVolume) {
                throw createExecutionError(
                    "pre_validation",
                    `FiveSocket execution maxVolume is required for symbol ${entry.symbol}`,
                    {
                        code: "MISSING_MAX_VOLUME",
                        retryable: false,
                        details: { symbol: entry.symbol },
                    }
                )
            }
            return {
                symbol: entry.symbol,
                maxVolume,
            }
        })
    }

    private async listDeals(
        credentials: MT5WorkerCredentials,
        lookbackHours: number
    ): Promise<FiveSocketDeal[]> {
        const accountId = await this.ensureAccount(credentials)
        const to = new Date()
        const from = new Date(to.getTime() - Math.max(lookbackHours, 1) * 60 * 60 * 1000)
        const deals: FiveSocketDeal[] = []
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

            deals.push(...(response.data ?? []))
            cursor = response.nextCursor
            if (!cursor) {
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
        }
    ): Promise<T> {
        if (options.budget === undefined && options.timeout === undefined) {
            throw new Error("FiveSocket requestJson requires timeout or budget")
        }

        const execute = async (): Promise<T> => {
            const timeout = options.budget?.remaining() ?? options.timeout!
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
                    const text = await response.text().catch(() => "")
                    const apiError = parseApiError(text)
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
                            },
                        }
                    )
                }

                if (response.status === 204) {
                    return undefined as T
                }

                return (await response.json()) as T
            } catch (error) {
                const detail = getExecutionErrorDetail(error)
                if (detail) {
                    throw error
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

        if (!options.budget) {
            return await retryWithBackoff(execute, 3, 1000, {
                shouldRetry: (error) => {
                    const detail = getExecutionErrorDetail(error)
                    return detail?.retryable === true
                },
            })
        }

        return await retryWithConnectBudget(execute, options.budget, 3, 1000)
    }
}

function accountCacheKey(credentials: MT5WorkerCredentials): string {
    return `${credentials.login}:${credentials.server}`
}

type TimeoutBudget = {
    remaining: () => number
}

function createTimeoutBudget(totalMs: number): TimeoutBudget {
    const deadline = Date.now() + totalMs
    return {
        remaining: () => {
            const left = deadline - Date.now()
            if (left <= 0) {
                throw createExecutionError(
                    "timeout",
                    `FiveSocket connect budget of ${totalMs}ms exhausted`,
                    {
                        code: "CONNECT_BUDGET_EXHAUSTED",
                        retryable: true,
                        details: { totalMs },
                    }
                )
            }
            return left
        },
    }
}

async function retryWithConnectBudget<T>(
    execute: () => Promise<T>,
    budget: TimeoutBudget,
    maxRetries: number,
    baseDelay: number
): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await execute()
        } catch (error) {
            lastError = error
            const detail = getExecutionErrorDetail(error)
            if (detail?.code === "CONNECT_BUDGET_EXHAUSTED") {
                throw error
            }
            const shouldRetry = attempt < maxRetries && detail?.retryable === true
            if (!shouldRetry) {
                throw error
            }

            const delay = baseDelay * Math.pow(2, attempt)
            let remaining: number
            try {
                remaining = budget.remaining()
            } catch {
                throw error
            }
            if (remaining <= delay) {
                throw createExecutionError(
                    "timeout",
                    "FiveSocket connect budget exhausted before retry backoff",
                    {
                        code: "CONNECT_BUDGET_EXHAUSTED",
                        retryable: true,
                        details: {
                            remainingMs: remaining,
                            requiredBackoffMs: delay,
                            attempt,
                        },
                    }
                )
            }
            await sleep(delay)
        }
    }
    throw lastError
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

function parseApiError(text: string): { code?: string; message?: string; requestId?: string } | undefined {
    if (!text.trim()) {
        return undefined
    }

    try {
        const parsed = JSON.parse(text) as FiveSocketApiErrorBody
        if (parsed.error) {
            return parsed.error
        }
    } catch {
        return undefined
    }

    return undefined
}

function stableBodyKey(value: unknown): string {
    return JSON.stringify(value)
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
