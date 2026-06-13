import {
    type DeleteStrategyResult,
    type Id,
    type PortfolioFreshnessRow,
    type ProviderPendingOrderRow,
    type ProviderPositionRow,
    type StoredStrategy,
    type TradingBackendClient,
} from "@valiq-trading/convex"
import {
    buildAccountSecretKeyMap,
    createLogger,
    ExecutionPipeline,
    resolveAccountScopedSecretKeys,
    validatePolicy,
    type Position,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import {
    isAlpacaRawOptionLegPosition,
    resolveAlpacaCloseGroupsFromPositions,
    resolveAlpacaForceResetCloseGroupsFromPositions,
} from "@valiq-trading/alpaca-options"
import { createOrderPersistenceAdapter } from "./strategy-cli"
import { AlpacaPlugin } from "../../src/plugins/alpaca"
import { OKXPlugin } from "../../src/plugins/okx"
import { MT5Plugin } from "../../src/plugins/mt5"
import { PolymarketPlugin } from "../../src/plugins/polymarket"
import type { VenueApp, VenuePlugin } from "../../src/types"

const RESET_PLUGINS: Partial<Record<VenueApp, VenuePlugin>> = {
    "alpaca-options": new AlpacaPlugin(),
    "okx-swap": new OKXPlugin(),
    "polymarket": new PolymarketPlugin(),
    "mt5": new MT5Plugin(),
}

export interface SafeStrategyResetResult {
    strategy: StoredStrategy
    deleted: DeleteStrategyResult
    cancelledOrders: number
    closedPositions: number
}

export interface VenueResetContext {
    venue: VenueAdapter
    venueName: string
    policy: Record<string, unknown>
}

export interface ResetExecutionContext extends VenueResetContext {
    pipeline: ExecutionPipeline
    runId: Id<"strategy_runs">
}

export interface VenueExposureResetResult {
    cancelledOrders: number
    closedPositions: number
    orderFailures: string[]
    positionFailures: string[]
}

export interface ResetFlattenExposure {
    app?: StoredStrategy["app"]
    positions: Array<ProviderPositionRow | Position>
    workingOrders: Array<ProviderPendingOrderRow | WorkingOrder>
    forceReset?: boolean
}

export interface VenueMarketClock {
    isOpen: boolean
    nextOpen?: string
    nextClose?: string
}

export interface MarketClosedResetBlock {
    provider: string
    positions: Array<Partial<ProviderPositionRow & Position> & Pick<Position, "instrument">>
    workingOrders: Array<Pick<ProviderPendingOrderRow, "orderId" | "instrument" | "metadata"> | Pick<WorkingOrder, "orderId" | "instrument" | "metadata">>
    nextOpen?: string
}

const RESET_VERIFICATION_ATTEMPTS = 6
const RESET_VERIFICATION_DELAY_MS = 1000

export async function resetStrategySafely(
    client: TradingBackendClient,
    strategyId: Id<"strategies">
): Promise<SafeStrategyResetResult> {
    const strategy = await client.getStrategyById(strategyId)

    if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`)
    }

    const trackedPositions = await client.getPortfolioPositions(strategy.app, strategy._id, strategy.accountId)
    const trackedOrders = await client.getPortfolioPendingOrders(strategy.app, strategy._id, strategy.accountId)
    const freshness = await getFreshness(client, strategy.app, strategy.accountId)

    assertResetPreconditions(strategy, freshness, trackedPositions, trackedOrders)

    const activeRun = await client.getActiveRun(strategy._id)
    if (activeRun) {
        throw new Error("Cannot reset a strategy with an active run")
    }

    await client.disableStrategy(strategy._id)

    let cancelledOrders = 0
    let closedPositions = 0

    if (!isDryRunStrategy(strategy)) {
        if (trackedPositions.length > 0 || trackedOrders.length > 0) {
            const result = await runWithResetExecutionContext(
                client,
                strategy,
                "safe strategy reset",
                async ({ pipeline }) => await flattenVenueExposure(pipeline, {
                    positions: trackedPositions,
                    workingOrders: trackedOrders,
                })
            )
            cancelledOrders = result.cancelledOrders
            closedPositions = result.closedPositions
        }

        await reconcileAndVerifyReset(client, strategy)
    }

    const deleted = await client.deleteStrategy(strategy._id)

    return {
        strategy,
        deleted,
        cancelledOrders,
        closedPositions,
    }
}

function assertResetPreconditions(
    strategy: StoredStrategy,
    freshness: PortfolioFreshnessRow | null,
    trackedPositions: ProviderPositionRow[],
    trackedOrders: ProviderPendingOrderRow[]
): void {
    if (isDryRunStrategy(strategy)) {
        return
    }

    const requiresHealthyProviderState =
        (freshness?.lastVerifiedAt ?? 0) > 0 ||
        trackedPositions.length > 0 ||
        trackedOrders.length > 0

    if (
        requiresHealthyProviderState &&
        (
            !freshness ||
            freshness.stale ||
            freshness.driftDetected ||
            freshness.providerStatus !== "healthy"
        )
    ) {
        throw new Error(
            `Refusing to reset ${strategy.name}: ${strategy.app} provider ownership is stale or drifted. Resolve venue ownership manually before retrying.`
        )
    }
}

export async function createVenue(
    strategy: StoredStrategy,
    client: TradingBackendClient
): Promise<VenueResetContext> {
    const plugin = RESET_PLUGINS[strategy.app]

    if (!plugin) {
        throw new Error(`No backend reset plugin registered for ${strategy.app}`)
    }

    const policy = validatePolicy(strategy.app, strategy.policy)
    const account = await client.getAccountByAppAndId(strategy.app, strategy.accountId)
    if (!account) {
        throw new Error(`Strategy ${strategy.name} (${strategy._id}) references missing account ${strategy.app}:${strategy.accountId}`)
    }
    if (account.status !== "active") {
        throw new Error(`Strategy ${strategy.name} (${strategy._id}) references inactive account ${strategy.app}:${strategy.accountId}`)
    }

    const canonicalSecretKeys = [
        ...plugin.resolveSecretKeys(),
        ...(plugin.resolveAdditionalSecretKeys?.(policy) ?? []),
    ]
    const accountScopedKeys = resolveAccountScopedSecretKeys(strategy.app, canonicalSecretKeys)
    const accountSecretKeyMap = buildAccountSecretKeyMap(account, accountScopedKeys)
    const accountScopedKeySet = new Set(accountScopedKeys)
    const sharedSecretKeys = canonicalSecretKeys.filter((key) => !accountScopedKeySet.has(key))
    const [sharedSecrets, prefixedAccountSecrets] = await Promise.all([
        sharedSecretKeys.length > 0 ? client.resolveSecrets(sharedSecretKeys) : Promise.resolve({}),
        accountSecretKeyMap.size > 0 ? client.resolveSecrets(Array.from(accountSecretKeyMap.values())) : Promise.resolve({}),
    ])
    const accountSecrets = Object.fromEntries(
        Array.from(accountSecretKeyMap.entries()).map(([canonicalKey, prefixedKey]) => [
            canonicalKey,
            prefixedAccountSecrets[prefixedKey] ?? null,
        ])
    )

    return {
        venue: plugin.createVenueAdapter(policy, {
            ...sharedSecrets,
            ...accountSecrets,
        }),
        venueName: plugin.venueName,
        policy,
    }
}

export async function createResetExecutionContext(
    client: TradingBackendClient,
    strategy: StoredStrategy
): Promise<ResetExecutionContext> {
    const context = await createVenue(strategy, client)
    const orderPersistence = createOrderPersistenceAdapter({
        app: strategy.app,
        accountId: strategy.accountId,
        strategyId: strategy._id,
    })
    const runId = await client.createRun(strategy._id, strategy.app, "manual")
    const logger = createLogger({
        app: strategy.app,
        strategyId: strategy._id,
        runId,
    }).child({
        operation: "reset_flatten",
    })
    const pipeline = new ExecutionPipeline({
        venue: context.venue,
        venueName: context.venueName,
        policy: context.policy,
        logger,
        tradeEventLogger: client,
        orderPersistence,
        runId,
        strategyId: strategy._id,
        executionSafetyFaultRecorder: async (fault) => {
            await client.recordExecutionSafetyFault({
                strategyId: strategy._id,
                app: strategy.app,
                instrument: fault.instrument,
                category: fault.category ?? "commit_unknown",
                message: fault.message,
                providerPayload: fault.providerPayload,
                canonicalOrderId: fault.canonicalOrderId,
                providerOrderId: fault.providerOrderId,
                providerClientOrderId: fault.providerClientOrderId,
                providerOrderAliases: fault.providerOrderAliases,
                submitAttemptId: fault.submitAttemptId,
                submitAttemptSequence: fault.submitAttemptSequence,
                runId,
                venue: fault.venue,
                signedOrderFingerprint: fault.signedOrderFingerprint,
                recoveryProbeEvidence: fault.recoveryProbeEvidence,
                blocked: true,
            })
        },
    })

    return {
        ...context,
        pipeline,
        runId,
    }
}

export async function runWithResetExecutionContext<T>(
    client: TradingBackendClient,
    strategy: StoredStrategy,
    operation: string,
    task: (context: ResetExecutionContext) => Promise<T>
): Promise<T> {
    const context = await createResetExecutionContext(client, strategy)

    try {
        const result = await task(context)
        await client.updateRun(context.runId, "completed", `${operation} completed`)
        return result
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await client.updateRun(context.runId, "failed", undefined, message)
        throw error
    } finally {
        context.pipeline.stopAllTracking()
    }
}

export type FlattenVenueExposureOptions = {
    forceReset?: boolean
}

export async function flattenVenueExposure(
    pipeline: Pick<ExecutionPipeline, "cancelOrder" | "closeProviderPosition">,
    exposure: ResetFlattenExposure,
    options: FlattenVenueExposureOptions = {}
): Promise<VenueExposureResetResult> {
    const forceReset = options.forceReset ?? exposure.forceReset
    const cancelledOrders = await cancelOrders(
        pipeline,
        uniqueStrings(exposure.workingOrders.map(resolveWorkingOrderCancelId))
    )
    const closedPositions = await closePositions(
        pipeline,
        exposure.positions,
        exposure.app,
        {
            forceReset,
        }
    )

    return {
        cancelledOrders: cancelledOrders.count,
        closedPositions: closedPositions.count,
        orderFailures: cancelledOrders.failures,
        positionFailures: closedPositions.failures,
    }
}

export async function resolveResetFlattenExposure(
    client: TradingBackendClient,
    strategy: StoredStrategy,
    liveExposure: ResetFlattenExposure
): Promise<ResetFlattenExposure> {
    if (strategy.app !== "alpaca-options") {
        return {
            app: strategy.app,
            positions: liveExposure.positions,
            workingOrders: liveExposure.workingOrders,
            forceReset: liveExposure.forceReset,
        }
    }

    await refreshProviderPortfolioState(client, strategy)

    const [reconciledPositions, reconciledWorkingOrders] = await Promise.all([
        client.getPortfolioPositions(strategy.app, undefined, strategy.accountId),
        client.getPortfolioPendingOrders(strategy.app, undefined, strategy.accountId),
    ])
    const liveProviderPositions = reconciledPositions.filter((position) =>
        !isDryRunVirtualProviderPosition(position)
    )
    const selectedPositions = liveProviderPositions.length > 0
        ? liveProviderPositions
        : liveExposure.positions

    return {
        app: strategy.app,
        positions: selectedPositions,
        workingOrders: reconciledWorkingOrders.length > 0
            ? reconciledWorkingOrders
            : liveExposure.workingOrders,
        forceReset: liveExposure.forceReset,
    }
}

export async function detectMarketClosedResetBlock(
    provider: string,
    venue: VenueAdapter,
    exposure?: {
        positions: Array<Partial<ProviderPositionRow & Position> & Pick<Position, "instrument">>
        workingOrders: Array<Pick<ProviderPendingOrderRow, "orderId" | "instrument" | "metadata"> | Pick<WorkingOrder, "orderId" | "instrument" | "metadata">>
    }
): Promise<MarketClosedResetBlock | null> {
    if (!hasMarketClock(venue)) {
        return null
    }

    const clock = await venue.getMarketClock()
    if (clock.isOpen) {
        return null
    }

    const [positions, workingOrders] = exposure
        ? [exposure.positions, exposure.workingOrders]
        : await Promise.all([
            venue.getPositions(),
            venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
        ])

    if (positions.length === 0) {
        return null
    }

    const groupedPositions = resolveAlpacaCloseGroupsFromPositions(positions as Array<ProviderPositionRow | Position>)
    const positionInstruments = new Set([
        ...positions.map((position) => position.instrument),
        ...groupedPositions.map((position) => position.instrument),
    ])
    if (workingOrders.length === 0) {
        return {
            provider,
            positions,
            workingOrders: [],
            nextOpen: clock.nextOpen,
        }
    }

    const matchingWorkingOrders = workingOrders.filter((order) =>
        positionInstruments.has(order.instrument) && isCloseWorkingOrder(order)
    )

    if (matchingWorkingOrders.length === 0) {
        return null
    }

    return {
        provider,
        positions,
        workingOrders: matchingWorkingOrders,
        nextOpen: clock.nextOpen,
    }
}

export function isMarketClosedExecutionFailure(
    provider: string,
    message: string
): boolean {
    if (provider !== "alpaca-options") {
        return false
    }

    const normalized = message.toLowerCase()
    return normalized.includes("market closed") ||
        normalized.includes("market is closed") ||
        normalized.includes("market is not open") ||
        normalized.includes("outside market hours") ||
        normalized.includes("option market has closed")
}

async function cancelOrders(
    pipeline: Pick<ExecutionPipeline, "cancelOrder">,
    orderIds: string[]
): Promise<{
    count: number
    failures: string[]
}> {
    let cancelled = 0
    const failures: string[] = []

    for (const orderId of orderIds) {
        try {
            const result = await pipeline.cancelOrder(orderId, "reset flatten")
            if (result.status === "cancelled" || result.status === "filled") {
                cancelled++
            } else {
                failures.push(`order ${orderId}: ${result.error ?? result.status}`)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`order ${orderId}: ${message}`)
        }
    }

    return {
        count: cancelled,
        failures,
    }
}

async function closePositions(
    pipeline: Pick<ExecutionPipeline, "closeProviderPosition">,
    positions: Array<ProviderPositionRow | Position>,
    app?: StoredStrategy["app"],
    options: FlattenVenueExposureOptions = {}
): Promise<{
    count: number
    failures: string[]
}> {
    let closed = 0
    const failures: string[] = []
    const closeRequests = app === "alpaca-options" && options.forceReset
        ? resolveAlpacaForceResetCloseGroupsFromPositions(positions)
        : resolveAlpacaCloseGroupsFromPositions(positions)

    for (const position of closeRequests) {
        if (isUnsafeAlpacaRawLegClose(position, app)) {
            failures.push(`position ${formatPositionIdentity(position)}: Alpaca raw option leg close requires complete claimed structure evidence`)
            continue
        }

        try {
            const { result } = await pipeline.closeProviderPosition(position, "reset flatten")
            if (result.status === "filled") {
                closed++
            } else {
                failures.push(`position ${formatPositionIdentity(position)}: ${result.error ?? `close status ${result.status} does not prove flat exposure`}`)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`position ${formatPositionIdentity(position)}: ${message}`)
        }
    }

    return {
        count: closed,
        failures,
    }
}

function isUnsafeAlpacaRawLegClose(position: ProviderPositionRow | Position, app?: StoredStrategy["app"]): boolean {
    return (readPositionApp(position) ?? app) === "alpaca-options" && isAlpacaRawOptionLegPosition(position)
}

function readPositionApp(position: ProviderPositionRow | Position): string | undefined {
    const app = (position as { app?: unknown }).app
    return typeof app === "string" ? app : undefined
}

function isDryRunVirtualProviderPosition(position: ProviderPositionRow): boolean {
    return position.metadata?.dryRun === true ||
        position.metadata?.source === "strategy_virtual_position"
}

export async function reconcileAndVerifyReset(
    client: TradingBackendClient,
    strategy: StoredStrategy,
    strategyId?: Id<"strategies">,
    options?: {
        requireHealthyState?: boolean
    }
): Promise<void> {
    const requireHealthyState = options?.requireHealthyState ?? true
    let lastFreshness: PortfolioFreshnessRow | null = null
    let lastRemainingPositions: ProviderPositionRow[] = []
    let lastRemainingOrders: ProviderPendingOrderRow[] = []

    for (let attempt = 0; attempt < RESET_VERIFICATION_ATTEMPTS; attempt++) {
        await refreshProviderPortfolioState(client, strategy)
        const verificationState = await Promise.all([
            getFreshness(client, strategy.app, strategy.accountId),
            client.getPortfolioPositions(strategy.app, strategyId, strategy.accountId),
            client.getPortfolioPendingOrders(strategy.app, strategyId, strategy.accountId),
        ])
        lastFreshness = verificationState[0]
        lastRemainingPositions = verificationState[1]
        lastRemainingOrders = verificationState[2]

        const healthy =
            lastFreshness &&
            !lastFreshness.stale &&
            !lastFreshness.driftDetected &&
            lastFreshness.providerStatus === "healthy"

        if (
            lastRemainingPositions.length === 0 &&
            lastRemainingOrders.length === 0 &&
            (!requireHealthyState || healthy)
        ) {
            return
        }

        if (attempt < RESET_VERIFICATION_ATTEMPTS - 1) {
            await sleep(RESET_VERIFICATION_DELAY_MS)
        }
    }

    if (
        requireHealthyState &&
        (
            !lastFreshness ||
            lastFreshness.stale ||
            lastFreshness.driftDetected ||
            lastFreshness.providerStatus !== "healthy"
        )
    ) {
        throw new Error(
            `Reset verification failed for ${strategy.name}: ${strategy.app} provider ownership is stale or drifted after cleanup.`
        )
    }

    throw new Error(
        `Reset verification failed for ${strategy.name}: ${lastRemainingPositions.length} provider position(s) and ${lastRemainingOrders.length} working order(s) still remain. ${formatRemainingExposure(lastRemainingPositions, lastRemainingOrders)}`
    )
}

export async function refreshProviderPortfolioState(
    client: TradingBackendClient,
    strategy: StoredStrategy
): Promise<void> {
    const { venue, venueName } = await createVenue(strategy, client)
    const [accountState, positions, workingOrders] = await Promise.all([
        venue.getAccountState(),
        venue.getPositions(),
        venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
    ])

    await client.reconcileProviderPortfolio(
        strategy.app,
        strategy.accountId,
        venueName,
        "periodic_sync",
        accountState,
        positions,
        workingOrders
    )
}

async function getFreshness(
    client: TradingBackendClient,
    app: VenueApp,
    accountId: string
): Promise<PortfolioFreshnessRow | null> {
    const rows = await client.getPortfolioFreshness(app, accountId)
    return rows[0] ?? null
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values))
}

function resolveWorkingOrderCancelId(order: ProviderPendingOrderRow | WorkingOrder): string {
    return order.canonicalOrderId ??
        order.orderId ??
        order.providerOrderId ??
        order.providerClientOrderId ??
        order.signedOrderFingerprint
}

function formatPositionIdentity(position: ProviderPositionRow | Position): string {
    const providerPositionId = position.providerPositionId
    return providerPositionId
        ? `${position.instrument}:${providerPositionId}`
        : position.instrument
}

function formatRemainingExposure(
    positions: ProviderPositionRow[],
    orders: ProviderPendingOrderRow[]
): string {
    const parts: string[] = []

    if (positions.length > 0) {
        parts.push(`positions=${formatPositionList(positions)}`)
    }

    if (orders.length > 0) {
        parts.push(`orders=${formatOrderList(orders)}`)
    }

    return parts.join("; ")
}

function formatPositionList(positions: ProviderPositionRow[]): string {
    const values = uniqueStrings(
        positions.map((position) => `${position.instrument}:${position.quantity}`)
    )
    return formatList(values)
}

function formatOrderList(orders: ProviderPendingOrderRow[]): string {
    const values = uniqueStrings(
        orders.map((order) => `${order.orderId}:${order.instrument}`)
    )
    return formatList(values)
}

function formatList(values: string[]): string {
    if (values.length <= 5) {
        return values.join(", ")
    }

    return `${values.slice(0, 5).join(", ")}, ... (+${values.length - 5} more)`
}

function hasMarketClock(
    venue: VenueAdapter
): venue is VenueAdapter & { getMarketClock(): Promise<VenueMarketClock> } {
    return typeof (venue as Partial<{ getMarketClock(): Promise<VenueMarketClock> }>).getMarketClock === "function"
}

function isCloseWorkingOrder(
    order: Pick<ProviderPendingOrderRow, "metadata"> | Pick<WorkingOrder, "metadata">
): boolean {
    const legs = order.metadata?.legs
    if (!Array.isArray(legs) || legs.length === 0) {
        return false
    }

    return legs.every((leg) => {
        if (!leg || typeof leg !== "object") {
            return false
        }

        const record = leg as Record<string, unknown>
        return record.position_intent === "buy_to_close" ||
            record.position_intent === "sell_to_close" ||
            record.side === "buy_to_close" ||
            record.side === "sell_to_close"
    })
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

export function isDryRunStrategy(strategy: Pick<StoredStrategy, "policy">): boolean {
    return strategy.policy.dryRun === true
}
